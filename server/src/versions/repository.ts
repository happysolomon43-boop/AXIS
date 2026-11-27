import { reportFailure } from "../logging.js";
import type { Pool } from "pg";
import type { BlockRow, ChapterRef, ChapterRow, VersionRow } from "../corpus/repo.js";
import { findOwnedChapter } from "../corpus/repo.js";
import { readOnlyTransaction, transaction } from "../db/transaction.js";
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

export function getVersionSource(pool: Pool, ownerId: string, chapterId: string, versionId: string) {
  if ([...chapterId].length > 64 || chapterId.includes("\u0000")) {
    throw new AppError(404, "not_found", "Chapter not found");
  }

  return transaction(pool, readOnlyTransaction, async (client) => {
    const chapter = await findOwnedChapter(client, ownerId, chapterId);
    if (!chapter) throw new AppError(404, "not_found", "Chapter not found");
    if ([...versionId].length > 64 || versionId.includes("\u0000")) {
      throw new AppError(404, "not_found", "Version not found");
    }

    const { rows: [text] } = await client.query<{ chapter_id: string; version_id: string; content: string }>(
      "SELECT chapter_id, id AS version_id, content FROM chapter_versions WHERE chapter_id = $1 AND id = $2",
      [chapter.id, versionId],
    );
    if (!text) throw new AppError(404, "not_found", "Version not found");
    return text;
  });
}
