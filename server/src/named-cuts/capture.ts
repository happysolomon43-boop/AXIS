/// <reference lib="es2024.string" />
import type { Pool, PoolClient } from "pg";
import { findOwnedChapter, readActiveVersionId, type VersionRow } from "../corpus/repo.js";
import { checkContent } from "../corpus/validate.js";
import { AppError } from "../errors.js";
import { readChapterSync } from "../sync/read.js";
import type { ChapterSync } from "../sync/state.js";
import { columns, defaultSnapshotName, dto, invalidName, type NamedSnapshot, type StoredSnapshot } from "./repository.js";

export const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export type CaptureRequest = { request_id: string; content: string; base_version: string; base_revision: number; name?: string };
export type CaptureResult = { request_id: string; snapshot: NamedSnapshot; version: VersionRow; created_version: boolean; draft_current: boolean; active_version_id: string | null; sync: ChapterSync };
type Receipt = { chapter_id: string; request_id: string; request_hash: string; captured_version_id: string; draft_base_version_id: string; draft_base_revision: number; created_version: boolean };
type StoredVersion = Omit<VersionRow, "l_seq"> & { l_seq: string };
type Coordinates = { id: string; revision: number };
const versionColumns = "id, chapter_id, version_no, source, text_hash, hints_hash, parent_version, l_seq";
const notFound = () => new AppError(404, "not_found", "Chapter not found");
export const invalid = (path: string, message: string) => new AppError(400, "validation_failed", "Request validation failed", { errors: [{ path, message }] });
const conflict = (reason: string, message: string) => new AppError(409, "snapshot_conflict", message, { reason });

async function transaction<T>(pool: Pool, begin: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(begin);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
async function coordinates(client: PoolClient, chapterId: string): Promise<Coordinates | undefined> {
  const { rows: [current] } = await client.query<Coordinates>(
    `SELECT v.id, COALESCE(d.revision,0) AS revision FROM chapter_versions v
     LEFT JOIN chapter_drafts d ON d.chapter_id=v.chapter_id
     WHERE v.chapter_id=$1 ORDER BY v.version_no DESC LIMIT 1`, [chapterId]);
  return current;
}
async function receiptFor(client: PoolClient, chapterId: string, requestId: string): Promise<Receipt | undefined> {
  return (await client.query<Receipt>("SELECT * FROM snapshot_capture_requests WHERE chapter_id=$1 AND request_id=$2", [chapterId, requestId])).rows[0];
}
export async function projectCapture(client: PoolClient, receipt: Receipt): Promise<CaptureResult> {
  const { rows: [version] } = await client.query<StoredVersion>(
    `SELECT ${versionColumns} FROM chapter_versions WHERE chapter_id=$1 AND id=$2`, [receipt.chapter_id, receipt.captured_version_id]);
  const { rows: [snapshot] } = await client.query<StoredSnapshot>(
    `SELECT ${columns} FROM named_cuts WHERE chapter_id=$1 AND version_id=$2`, [receipt.chapter_id, receipt.captured_version_id]);
  if (!version || !snapshot || snapshot.l_seq !== version.l_seq) throw new Error("Missing capture reference");
  const current = await coordinates(client, receipt.chapter_id);
  return {
    request_id: receipt.request_id, snapshot: dto(snapshot), version: { ...version, l_seq: Number(version.l_seq) },
    created_version: receipt.created_version,
    draft_current: current?.id === receipt.draft_base_version_id && current.revision === receipt.draft_base_revision,
    active_version_id: await readActiveVersionId(client, receipt.chapter_id),
    sync: await readChapterSync(client, receipt.chapter_id),
  };
}

export function captureChapterSnapshot(pool: Pool, actorId: string, chapterId: string, body: CaptureRequest): Promise<{ status: 200 | 201; capture: CaptureResult }> {
  return transaction(pool, "BEGIN", async client => {
    const initial = await findOwnedChapter(client, actorId, chapterId);
    if (!initial) throw notFound();
    const lock = await client.query("SELECT id FROM series WHERE id=$1 AND owner_id=$2 FOR NO KEY UPDATE", [initial.series_id, actorId]);
    if (!lock.rowCount) throw notFound();
    const { rows: [chapter] } = await client.query<{ id: string; book_id: string; series_id: string; status: string }>(
      `SELECT c.id,c.book_id,b.series_id,b.status FROM chapters c JOIN books b ON b.id=c.book_id
       JOIN series s ON s.id=b.series_id WHERE c.id=$1 AND s.owner_id=$2 AND s.id=$3 AND b.id=$4`,
      [chapterId, actorId, initial.series_id, initial.book_id]);
    if (!chapter) throw notFound();
    checkContent(body.content);
    let name: string | null = null;
    if (body.name !== undefined) {
      if (!body.name.isWellFormed() || body.name.includes("\u0000")) throw invalidName();
      const { rows: [folded] } = await client.query<{ name: string }>("SELECT axis_fold($1) AS name", [body.name]);
      if ([...folded!.name].length > 200) throw invalidName();
      name = folded!.name || null;
    }
    const { rows: [fingerprint] } = await client.query<{ hash: string }>(
      "SELECT encode(sha256(convert_to(jsonb_build_array($1::text,$2::text,$3::integer,$4::text)::text,'UTF8')),'hex') AS hash",
      [body.content, body.base_version, body.base_revision, name]);
    const hash = fingerprint!.hash;
    const prior = await receiptFor(client, chapterId, body.request_id);
    if (prior) {
      if (prior.request_hash !== hash) throw conflict("request_mismatch", "Snapshot request ID already used");
      return { status: 200, capture: await projectCapture(client, prior) };
    }
    if (chapter.status === "released") throw conflict("released_book", "Released chapters require a locked version");
    const { rows: [current] } = await client.query<Coordinates & { hints_hash: string; exact: boolean; hinted: boolean }>(
      `SELECT v.id,COALESCE(d.revision,0) AS revision,v.hints_hash,
        convert_to(v.content,'UTF8')=convert_to($2,'UTF8') AS exact,
        EXISTS(SELECT 1 FROM scenes s WHERE s.version_id=v.id AND
          (s.pov_hint IS NOT NULL OR s.location_hint IS NOT NULL OR s.time_hint IS NOT NULL OR s.time_mode<>'linear')) AS hinted
       FROM chapter_versions v LEFT JOIN chapter_drafts d ON d.chapter_id=v.chapter_id
       WHERE v.chapter_id=$1 ORDER BY v.version_no DESC LIMIT 1`, [chapterId, body.content]);
    if (!current) throw invalid("/base_version", "save a chapter version first");
    const reason = body.base_version !== current.id ? "version" : body.base_revision !== current.revision ? "revision" : null;
    if (reason) throw new AppError(409, "conflict", "Draft is out of date", { reason, current_version: current.id, current_revision: current.revision });
    const { rows: [count] } = await client.query<{ words: string }>(
      "SELECT COALESCE(sum(axis_word_count(b->>'text')),0) AS words FROM jsonb_array_elements(axis_segment($1)) b WHERE b->>'kind' IN ('paragraph','heading')", [body.content]);
    if (Number(count!.words) === 0) throw invalid("/content", "nothing to capture");
    if (current.hinted && !current.exact) throw conflict("scene_hints", "Changed draft text cannot be captured with saved scene hints");
    const { rows: [matched] } = await client.query<{ id: string }>(
      "SELECT id FROM chapter_versions WHERE chapter_id=$1 AND convert_to(content,'UTF8')=convert_to($2,'UTF8') AND hints_hash=$3 ORDER BY version_no DESC LIMIT 1",
      [chapterId, body.content, current.hints_hash]);
    const created = !matched;
    let versionId = matched?.id;
    if (!versionId) {
      const { rows: [committed] } = await client.query<{ result: { ids: string[] } }>(
        "SELECT commit_inputs($1,'corpus',$2,'chapter.version.append',$3::jsonb) AS result",
        [chapter.series_id, actorId, JSON.stringify([{ kind: "chapter_version", chapter_id: chapterId, content: body.content, source: "draft_edit", parent_version: current.id }])]);
      versionId = committed?.result.ids[0];
      if (!versionId) throw new Error("Missing committed version");
    }
    const { rows: [existing] } = await client.query<StoredSnapshot>(
      `SELECT ${columns} FROM named_cuts WHERE chapter_id=$1 AND version_id=$2`, [chapterId, versionId]);
    if (existing) {
      if (name !== null && name !== existing.label) throw conflict("name_exists", "This version already has a snapshot name");
    } else {
      const { rows: [selected] } = await client.query<{ id: string; parent_version: string | null; series_id: string; l_seq: string; day: string }>(
        `SELECT v.id,v.parent_version,v.series_id,v.l_seq,to_char(l.at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day
         FROM chapter_versions v JOIN ledger l ON l.series_id=v.series_id AND l.l_seq=v.l_seq
         WHERE v.chapter_id=$1 AND v.id=$2`, [chapterId, versionId]);
      if (!selected) throw new Error("Missing selected version");
      const label = name ?? await defaultSnapshotName(client, chapter, selected);
      await client.query("INSERT INTO named_cuts (chapter_id,version_id,series_id,l_seq,label) VALUES($1,$2,$3,$4,$5)",
        [chapterId, versionId, selected.series_id, selected.l_seq, label]);
    }
    const after = await coordinates(client, chapterId);
    if (!after) throw new Error("Missing after state");
    const { rows: [receipt] } = await client.query<Receipt>(
      `INSERT INTO snapshot_capture_requests(chapter_id,request_id,request_hash,captured_version_id,draft_base_version_id,draft_base_revision,created_version)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [chapterId, body.request_id, hash, versionId, after.id, after.revision, created]);
    if (!receipt) throw new Error("Missing receipt");
    return { status: 201, capture: await projectCapture(client, receipt) };
  });
}
