/// <reference lib="es2024.string" />
import { reportFailure } from "../logging.js";
import type { Pool, PoolClient } from "pg";
import { AppError } from "../errors.js";

export type NamedSnapshot = {
  chapter_id: string;
  version_id: string;
  kind: "snapshot";
  name: string;
  l_seq: number;
  pack_pins: Record<string, never>;
  created_at: string;
};
export type NameInput = { kind: "snapshot"; chapter_id: string; version_id: string; name?: string };
export type StoredSnapshot = Omit<NamedSnapshot, "name" | "l_seq" | "created_at"> & {
  label: string; l_seq: string; created_at: Date;
};
export function dto(row: StoredSnapshot): NamedSnapshot {
  return { chapter_id: row.chapter_id, version_id: row.version_id, kind: row.kind,
    name: row.label, l_seq: Number(row.l_seq), pack_pins: row.pack_pins, created_at: row.created_at.toISOString() };
}
function invalid(path: string, message: string): AppError {
  return new AppError(400, "validation_failed", "Request validation failed", { errors: [{ path, message }] });
}
export const invalidName = () => invalid("/name", "must be at most 200 characters after whitespace normalization and must not contain NUL or unpaired surrogates");
function missing(what: string): never {
  throw new AppError(404, "not_found", what + " not found");
}
export const columns = "chapter_id, version_id, kind, label, l_seq, pack_pins, created_at";
export async function nameSavedVersion(pool: Pool, ownerId: string, seriesId: string, input: NameInput):
Promise<{ status: 200 | 201; snapshot: NamedSnapshot }> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const series = await client.query("SELECT id FROM series WHERE id = $1 AND owner_id = $2 FOR NO KEY UPDATE", [seriesId, ownerId]);
    if (!series.rowCount) missing("Series");
    const { rows: [chapter] } = await client.query<{ id: string; book_id: string; status: string }>(
      "SELECT c.id, c.book_id, b.status FROM chapters c JOIN books b ON b.id = c.book_id WHERE c.id = $1 AND b.series_id = $2",
      [input.chapter_id, seriesId]);
    if (!chapter) missing("Chapter");
    const { rows: [version] } = await client.query<{ id: string; parent_version: string | null; source: string; op: string; l_seq: string; day: string }>(
      `SELECT v.id, v.parent_version, v.source, v.l_seq, l.op, to_char(l.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
       FROM chapter_versions v JOIN ledger l ON l.series_id = v.series_id AND l.l_seq = v.l_seq
       WHERE v.id = $1 AND v.chapter_id = $2 AND v.series_id = $3`, [input.version_id, chapter.id, seriesId]);
    if (!version) missing("Version");
    let name = "";
    if (input.name !== undefined) {
      if (!input.name.isWellFormed() || input.name.includes("\u0000")) throw invalidName();
      const folded = await client.query<{ name: string }>("SELECT axis_fold($1) AS name", [input.name]);
      name = folded.rows[0]!.name;
      if ([...name].length > 200) throw invalidName();
    }
    const { rows: [existing] } = await client.query<StoredSnapshot>(
      `SELECT ${columns} FROM named_cuts WHERE chapter_id = $1 AND version_id = $2`, [chapter.id, version.id]);
    if (existing) {
      if (name !== "" && name !== existing.label) {
        throw new AppError(409, "snapshot_conflict", "This version already has a snapshot name", { reason: "name_exists" });
      }
      await client.query("COMMIT");
      return { status: 200, snapshot: dto(existing) };
    }
    if (chapter.status === "released") throw new AppError(409, "snapshot_conflict", "Released chapters require a locked version", { reason: "released_book" });
    const count = await client.query<{ words: string }>(
      "SELECT COALESCE(sum(axis_word_count(text)),0) AS words FROM blocks WHERE version_id = $1 AND kind IN ('paragraph','heading')", [version.id]);
    if (Number(count.rows[0]!.words) === 0) throw invalid("/version_id", "nothing to capture");
    if (version.source !== "draft_edit" || version.op !== "chapter.version.append") throw invalid("/version_id", "select a version created by Save");
    if (!name) {
      name = await defaultSnapshotName(client, chapter, version);
    }
    const { rows: [inserted] } = await client.query<StoredSnapshot>(
      `INSERT INTO named_cuts (chapter_id, version_id, series_id, l_seq, label)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${columns}`, [chapter.id, version.id, seriesId, version.l_seq, name]);
    if (!inserted) throw new Error("Missing snapshot row");
    await client.query("COMMIT");
    return { status: 201, snapshot: dto(inserted) };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (rollbackError) { reportFailure("database_rollback_failed", rollbackError); discard = true; }
    throw error;
  } finally { client.release(discard); }
}

export async function defaultSnapshotName(client: PoolClient, chapter: { id: string; book_id: string }, version: { id: string; parent_version: string | null; day: string }): Promise<string> {
  const rank = await client.query<{ rank: string }>(
    `SELECT rank FROM (SELECT id, row_number() OVER (ORDER BY order_key COLLATE "C", id COLLATE "C") AS rank
      FROM chapters WHERE book_id = $1) ranked WHERE id = $2`, [chapter.book_id, chapter.id]);
  const sentences = async (id: string | null): Promise<string[]> => {
    if (id === null) return [];
    const { rows } = await client.query<{ sentence: string }>(
      `SELECT s.sentence FROM blocks b CROSS JOIN LATERAL unnest(axis_sentences(b.text)) WITH ORDINALITY AS s(sentence, n)
       WHERE b.version_id = $1 AND b.kind IN ('paragraph','heading') ORDER BY b.ordinal, s.n`, [id]);
    return rows.map(row => row.sentence);
  };
  const selected = await sentences(version.id);
  const parent = await sentences(version.parent_version);
  const firstDifference = selected.findIndex((sentence, i) => sentence !== parent[i]);
  const excerpt = firstDifference >= 0 ? selected[firstDifference]! :
    parent.length > selected.length ? selected[selected.length - 1]! : selected[0]!;
  const folded = await client.query<{ name: string }>("SELECT axis_fold($1) AS name", [
    "Chapter " + rank.rows[0]!.rank + " · " + version.day + " · " + [...excerpt].slice(0, 80).join("")
  ]);
  return folded.rows[0]!.name;
}
