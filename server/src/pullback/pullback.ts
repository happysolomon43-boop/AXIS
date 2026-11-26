import type { Pool } from "pg";
import { readActiveVersionId, readChapterRow, type ChapterRef, type ChapterRow } from "../corpus/repo.js";

export type PullBackWritten = { chapter: ChapterRow; active_version_id: string };

export async function pullBackChapter(pool: Pool, chapter: ChapterRef): Promise<PullBackWritten | null> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const activeVersionId = await readActiveVersionId(client, chapter.id);
    if (activeVersionId === null) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO chapter_pullbacks (chapter_id, book_version) VALUES ($1, $2)
       ON CONFLICT (chapter_id) DO UPDATE SET book_version = EXCLUDED.book_version`,
      [chapter.id, activeVersionId],
    );
    const chapterRow = await readChapterRow(client, chapter.id);
    await client.query("COMMIT");
    return { chapter: chapterRow, active_version_id: activeVersionId };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
