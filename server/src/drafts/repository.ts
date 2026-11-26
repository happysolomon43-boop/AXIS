import type { Pool, PoolClient } from "pg";
import type { BlockRow, ChapterRef, ChapterRow } from "../corpus/repo.js";
import { AppError } from "../errors.js";
import { readChapterSync } from "../sync/read.js";
import type { ChapterSync } from "../sync/state.js";

type DraftBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type DraftHead = { base_version: string; revision: number; content: string; blocks: DraftBlock[] };
export type DraftDetail = { chapter: ChapterRow; draft: DraftHead | null; sync: ChapterSync };
export type DraftWritten = { chapter: ChapterRow; base_version: string; revision: number; sync: ChapterSync };
export type DraftInput = { content: string; base_version: string; base_revision: number };

const readOnly = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

async function transaction<T>(
  pool: Pool,
  begin: "BEGIN" | typeof readOnly,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query(begin);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
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

async function readChapter(client: PoolClient, id: string): Promise<ChapterRow> {
  const { rows: [chapter] } = await client.query<ChapterRow>(
    "SELECT id, book_id, order_key FROM chapters WHERE id = $1",
    [id],
  );
  if (!chapter) throw new AppError(404, "not_found", "Chapter not found");
  return chapter;
}

export function putDraft(pool: Pool, chapter: ChapterRef, body: DraftInput): Promise<DraftWritten> {
  return transaction(pool, "BEGIN", async (client) => {
    await client.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const chapterRow = await readChapter(client, chapter.id);
    const { rows: [current] } = await client.query<{ id: string; revision: number }>(
      `SELECT v.id, COALESCE(d.revision, 0) AS revision
       FROM chapter_versions AS v
       LEFT JOIN chapter_drafts AS d ON d.chapter_id = v.chapter_id
       WHERE v.chapter_id = $1 ORDER BY v.version_no DESC LIMIT 1`,
      [chapter.id],
    );
    if (!current) throw new Error("Chapter has no base version for a draft");

    const reason = body.base_version !== current.id ? "version"
      : body.base_revision !== current.revision ? "revision" : null;
    if (reason !== null) {
      throw new AppError(409, "conflict", "Draft is out of date", {
        reason, current_version: current.id, current_revision: current.revision,
      });
    }

    const { rows: [written] } = current.revision === 0
      ? await client.query<{ revision: number }>(
        "INSERT INTO chapter_drafts (chapter_id, base_version, content, revision) VALUES ($1, $2, $3, 1) RETURNING revision",
        [chapter.id, body.base_version, body.content],
      )
      : await client.query<{ revision: number }>(
        "UPDATE chapter_drafts SET content = $2, revision = revision + 1 WHERE chapter_id = $1 RETURNING revision",
        [chapter.id, body.content],
      );
    if (!written) throw new Error("Draft write returned no row");
    const sync = await readChapterSync(client, chapter.id);
    return { chapter: chapterRow, base_version: current.id, revision: written.revision, sync };
  });
}

export function getDraft(pool: Pool, chapter: ChapterRef): Promise<DraftDetail> {
  return transaction(pool, readOnly, async (client) => {
    const chapterRow = await readChapter(client, chapter.id);
    const { rows: [head] } = await client.query<DraftHead>(
      `SELECT base_version, revision, content, axis_segment(content) AS blocks
       FROM chapter_drafts WHERE chapter_id = $1`,
      [chapter.id],
    );
    const sync = await readChapterSync(client, chapter.id);
    if (!head) return { chapter: chapterRow, draft: null, sync };

    const { blocks, ...draft } = head;
    return { chapter: chapterRow, draft: { ...draft, blocks: blocks.map(({ ordinal, kind, text }) => ({ ordinal, kind, text })) }, sync };
  });
}
