import { reportFailure } from "../logging.js";
import type { Pool } from "pg";
import type { BlockRow, ChapterRef, ChapterRow, VersionRow } from "../corpus/repo.js";
import { AppError } from "../errors.js";

export type VersionBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type VersionText = { chapter: ChapterRow; version: VersionRow; blocks: VersionBlock[] };

export async function getVersionText(pool: Pool, chapter: ChapterRef, versionId: string): Promise<VersionText | null> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [chapterRow] } = await client.query<ChapterRow>(
      "SELECT id, book_id, order_key FROM chapters WHERE id = $1",
      [chapter.id],
    );
    if (!chapterRow) throw new AppError(404, "not_found", "Chapter not found");

    const { rows: [version] } = await client.query<Omit<VersionRow, "l_seq"> & { l_seq: string }>(
      `SELECT id, chapter_id, version_no, source, text_hash, hints_hash, parent_version, l_seq
       FROM chapter_versions WHERE id = $1 AND chapter_id = $2`,
      [versionId, chapter.id],
    );
    if (!version) {
      await client.query("COMMIT");
      return null;
    }

    const { rows: blocks } = await client.query<VersionBlock>(
      "SELECT ordinal, kind, text FROM blocks WHERE version_id = $1 ORDER BY ordinal ASC",
      [versionId],
    );
    await client.query("COMMIT");
    return { chapter: chapterRow, version: { ...version, version_no: Number(version.version_no), l_seq: Number(version.l_seq) }, blocks };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      reportFailure("database_rollback_failed", rollbackError);
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
