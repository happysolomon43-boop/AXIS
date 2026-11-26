/// <reference lib="es2024.string" />
import type { Pool, PoolClient } from "pg";
import { findOwnedChapter } from "../corpus/repo.js";
import { AppError } from "../errors.js";
import { columns, dto, invalidName, type NamedSnapshot, type StoredSnapshot } from "./repository.js";

export type SnapshotLifecycle = { snapshot_id: string; state_token: string; previous_token: string | null };
export type SnapshotLabelAction = { action: "remove"; snapshot_id: string; expected_token: string } | { action: "undo"; snapshot_id: string; expected_token: string; name: string };
export type SnapshotLabelResult = { chapter_id: string; version_id: string; snapshot_lifecycle: SnapshotLifecycle; snapshot: NamedSnapshot | null; can_name_snapshot: boolean };
type Marker = SnapshotLifecycle & { removed_name_hash: string | null; removed_created_at: string | null };
type Label = StoredSnapshot & { series_id: string };
type Version = { series_id: string; l_seq: string; eligible: boolean };
const missing = (what: string) => new AppError(404, "not_found", what + " not found");
const changed = () => new AppError(409, "snapshot_conflict", "Snapshot name changed", { reason: "snapshot_changed" });
export async function readLabelPair(client: PoolClient, chapterId: string, versionId: string, version: { series_id: string; l_seq: string }) {
  const marker = (await client.query<Marker>(
    "SELECT snapshot_id,state_token,previous_token,removed_name_hash,removed_created_at::text AS removed_created_at FROM snapshot_label_lifecycles WHERE chapter_id=$1 AND version_id=$2", [chapterId,versionId])).rows[0];
  const label = (await client.query<Label>(
    `SELECT ${columns},series_id FROM named_cuts WHERE chapter_id=$1 AND version_id=$2`, [chapterId,versionId])).rows[0];
  if ((!marker && label) || (marker && ((marker.removed_name_hash === null) !== (marker.removed_created_at === null) ||
      (marker.removed_name_hash === null) !== Boolean(label))) ||
      (label && (label.series_id !== version.series_id || label.l_seq !== version.l_seq || label.kind !== "snapshot" || Object.keys(label.pack_pins).length !== 0)))
    throw new Error("Inconsistent snapshot label");
  return { marker, label };
}
function publicMarker(m: Marker): SnapshotLifecycle {
  return { snapshot_id:m.snapshot_id, state_token:m.state_token, previous_token:m.previous_token };
}
export async function changeChapterSnapshotLabel(pool: Pool, actorId: string, chapterId: string, versionId: string, body: SnapshotLabelAction): Promise<SnapshotLabelResult> {
  if (chapterId.length > 64 || chapterId.includes("\u0000")) throw missing("Chapter");
  const initial = await findOwnedChapter(pool,actorId,chapterId);
  if (!initial) throw missing("Chapter");
  const client=await pool.connect();
  let discard=false;
  try {
    await client.query("BEGIN");
    const lock=await client.query("SELECT id FROM series WHERE id=$1 AND owner_id=$2 FOR NO KEY UPDATE",[initial.series_id,actorId]);
    if (!lock.rowCount) throw missing("Chapter");
    const chapter=await findOwnedChapter(client,actorId,chapterId);
    if (!chapter || chapter.series_id!==initial.series_id || chapter.book_id!==initial.book_id) throw missing("Chapter");
    if (versionId.length > 64 || versionId.includes("\u0000")) throw missing("Version");
    const version=(await client.query<Version>(
      `SELECT v.series_id,v.l_seq,(book.status<>'released' AND v.source='draft_edit' AND l.op='chapter.version.append'
        AND COALESCE((SELECT sum(axis_word_count(b.text)) FROM blocks b WHERE b.version_id=v.id AND b.kind IN ('paragraph','heading')),0)>0) AS eligible
       FROM chapter_versions v JOIN ledger l ON l.series_id=v.series_id AND l.l_seq=v.l_seq
       JOIN chapters c ON c.id=v.chapter_id JOIN books book ON book.id=c.book_id
       WHERE v.chapter_id=$1 AND v.id=$2 AND v.series_id=$3`,[chapterId,versionId,chapter.series_id])).rows[0];
    if (!version) throw missing("Version");
    const {marker,label}=await readLabelPair(client,chapterId,versionId,version);
    if (body.action==="undo") {
      if (!body.name.isWellFormed() || body.name.includes("\u0000")) throw invalidName();
      const folded=(await client.query<{name:string}>("SELECT axis_fold($1) AS name",[body.name])).rows[0]!.name;
      if ([...folded].length>200) throw invalidName();
      if (!folded || folded!==body.name) throw new AppError(400,"validation_failed","Request validation failed",{errors:[{path:"/name",message:"must be a nonempty normalized snapshot name"}]});
    }
    if (!marker || marker.snapshot_id!==body.snapshot_id) throw changed();
    const wanted=body.action==="undo";
    const already=Boolean(label)===wanted;
    if (already && marker.previous_token===body.expected_token) {
      if (body.action==="undo" && label?.label!==body.name) throw changed();
    } else {
      if (already || marker.state_token!==body.expected_token) throw changed();
      if (body.action==="remove") {
        const removed=(await client.query<{label:string; stamp:string}>(
          "DELETE FROM named_cuts WHERE chapter_id=$1 AND version_id=$2 RETURNING label,created_at::text AS stamp",[chapterId,versionId])).rows[0];
        if (!removed) throw new Error("Missing removed name");
        await client.query(`UPDATE snapshot_label_lifecycles SET removed_name_hash=encode(sha256(convert_to($3,'UTF8')),'hex'),
          removed_created_at=$4::timestamptz,previous_token=state_token,state_token=gen_random_uuid() WHERE chapter_id=$1 AND version_id=$2`,
          [chapterId,versionId,removed.label,removed.stamp]);
      } else {
        const hash=(await client.query<{hash:string}>("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS hash",[body.name])).rows[0]!.hash;
        if (hash!==marker.removed_name_hash) throw changed();
        await client.query(`INSERT INTO named_cuts(chapter_id,version_id,series_id,l_seq,kind,label,pack_pins,created_at)
          VALUES($1,$2,$3,$4,'snapshot',$5,'{}'::jsonb,$6::timestamptz)`,[chapterId,versionId,version.series_id,version.l_seq,body.name,marker.removed_created_at]);
        await client.query("UPDATE snapshot_label_lifecycles SET snapshot_id=$3,previous_token=$4 WHERE chapter_id=$1 AND version_id=$2",
          [chapterId,versionId,marker.snapshot_id,marker.state_token]);
      }
    }
    const result=await readLabelPair(client,chapterId,versionId,version);
    if (!result.marker || Boolean(result.label)!==wanted) throw new Error("Missing lifecycle result");
    const response:SnapshotLabelResult={chapter_id:chapterId,version_id:versionId,snapshot_lifecycle:publicMarker(result.marker),
      snapshot:result.label?dto(result.label):null,can_name_snapshot:!result.label&&version.eligible};
    await client.query("COMMIT");
    return response;
  } catch(error) {
    try {await client.query("ROLLBACK");} catch {discard=true;}
    throw error;
  } finally {client.release(discard);}
}
