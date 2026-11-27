import type { Pool, PoolClient } from "pg";
import { findOwnedChapter, readChapterDetail, readChapterRow, type BlockRow, type ChapterDetail, type ChapterRef, type ChapterRow } from "../corpus/repo.js";
import { readOnlyTransaction, transaction } from "../db/transaction.js";
import { AppError } from "../errors.js";
import { readChapterSync } from "../sync/read.js";
import type { ChapterSync } from "../sync/state.js";

type DraftBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type DraftHead = { base_version: string; revision: number; content: string; blocks: DraftBlock[] };
export type DraftDetail = { chapter: ChapterRow; draft: DraftHead | null; sync: ChapterSync };
export type DraftWritten = { chapter: ChapterRow; base_version: string; revision: number; sync: ChapterSync };
export type DraftInput = { content: string; base_version: string; base_revision: number };

export function putDraft(pool: Pool, chapter: ChapterRef, body: DraftInput): Promise<DraftWritten> {
  return transaction(pool, "BEGIN", async (client) => {
    await client.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const chapterRow = await readChapterRow(client, chapter.id);
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

async function readDraftHead(client: PoolClient, id: string): Promise<DraftHead | null> {
  const { rows: [head] } = await client.query<DraftHead>(
    `SELECT base_version, revision, content, axis_segment(content) AS blocks
     FROM chapter_drafts WHERE chapter_id = $1`,
    [id],
  );
  if (!head) return null;
  const { blocks, ...draft } = head;
  return { ...draft, blocks: blocks.map(({ ordinal, kind, text }) => ({ ordinal, kind, text })) };
}

export function getDraft(pool: Pool, chapter: ChapterRef): Promise<DraftDetail> {
  return transaction(pool, readOnlyTransaction, async (client) => ({
    chapter: await readChapterRow(client, chapter.id),
    draft: await readDraftHead(client, chapter.id),
    sync: await readChapterSync(client, chapter.id),
  }));
}

export type WorkingState = ChapterDetail & Pick<DraftDetail, "draft" | "sync">;

export function getWorkingState(pool: Pool, owner: string, id: string): Promise<WorkingState> {
  return transaction(pool, readOnlyTransaction, async (client) => {
    if (!await findOwnedChapter(client, owner, id)) throw new AppError(404, "not_found", "Chapter not found");
    const detail = await readChapterDetail(client, id);
    const draft = await readDraftHead(client, id);
    if (draft !== null && draft.base_version !== detail.version?.id) throw new Error("Invalid draft base");
    return { ...detail, draft, sync: await readChapterSync(client, id) };
  });
}
