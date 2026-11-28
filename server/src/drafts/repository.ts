import type { Pool, PoolClient } from "pg";
import { findOwnedChapter, readChapterDetail, readChapterRow, type BlockRow, type ChapterDetail, type ChapterRef, type ChapterRow } from "../corpus/repo.js";
import { readOnlyTransaction, transaction } from "../db/transaction.js";
import { AppError } from "../errors.js";
import { readChapterSync } from "../sync/read.js";
import type { ChapterSync } from "../sync/state.js";

import { validateEditorDocument, type EditorDocument } from "./editor-document.js";
import { validateParagraphLineage, type ParagraphLineage } from "./paragraph-lineage.js";
import { projectDraftBlockUids, type WorkingDraftBlock } from "./paragraph-identity.js";

export type DraftBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type DraftHead = { base_version: string; revision: number; content: string; blocks: DraftBlock[] };
export type DraftDetail = { chapter: ChapterRow; draft: DraftHead | null; sync: ChapterSync };
export type DraftWritten = { chapter: ChapterRow; base_version: string; revision: number; sync: ChapterSync };
export type DraftInput = { content: string; base_version: string; base_revision: number; editor_document?: unknown; paragraph_lineage?: unknown };

export function putDraft(pool: Pool, chapter: ChapterRef, body: DraftInput, owner?: string): Promise<DraftWritten> {
  return transaction(pool, "BEGIN", async (client) => {
    const locked = await client.query<{ owner_id: string }>("SELECT owner_id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const actor = owner ?? locked.rows[0]?.owner_id;
    const owned = actor ? await findOwnedChapter(client, actor, chapter.id) : null;
    if (!locked.rowCount || owned?.series_id !== chapter.series_id || owned.book_id !== chapter.book_id) {
      throw new AppError(404, "not_found", "Chapter not found");
    }
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

    const supplied = Object.prototype.hasOwnProperty.call(body, "editor_document");
    const lineageSupplied = Object.prototype.hasOwnProperty.call(body, "paragraph_lineage");
    if (lineageSupplied && !supplied) {
      throw new AppError(400, "validation_failed", "Request validation failed", {
        errors: [{path:"/paragraph_lineage",message:"must accompany an editor_document"}],
      });
    }
    let document: string | null = null, lineage: string | null = null;
    if (supplied) {
      const { rows: [segmented] } = await client.query<{ blocks: DraftBlock[] }>("SELECT axis_segment($1) AS blocks", [body.content]);
      if (!segmented) throw new Error("Missing draft segmentation");
      const admitted = validateEditorDocument(body.editor_document, body.content, segmented.blocks);
      document = JSON.stringify(admitted);
      if (lineageSupplied) {
        const records = validateParagraphLineage(body.paragraph_lineage, admitted);
        lineage = records === null ? null : JSON.stringify(records);
      }
    }

    const { rows: [written] } = current.revision === 0
      ? await client.query<{ revision: number }>(
        "INSERT INTO chapter_drafts (chapter_id, base_version, content, revision, editor_document, paragraph_lineage) VALUES ($1, $2, $3, 1, $4::jsonb, $5::jsonb) RETURNING revision",
        [chapter.id, body.base_version, body.content, document, lineage],
      )
      : await client.query<{ revision: number }>(
        `UPDATE chapter_drafts SET
          paragraph_lineage = CASE WHEN $5::boolean THEN $6::jsonb
            WHEN $3::boolean THEN CASE WHEN editor_document = $4::jsonb THEN paragraph_lineage ELSE NULL END
            WHEN convert_to(content, 'UTF8') = convert_to($2, 'UTF8') THEN paragraph_lineage ELSE NULL END,
          editor_document = CASE WHEN $3::boolean THEN $4::jsonb
            WHEN convert_to(content, 'UTF8') = convert_to($2, 'UTF8') THEN editor_document ELSE NULL END,
          content = $2, revision = revision + 1 WHERE chapter_id = $1 RETURNING revision`,
        [chapter.id, body.content, supplied, document, lineageSupplied, lineage],
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

export type WorkingDraftHead = Omit<DraftHead, "blocks"> & { blocks: WorkingDraftBlock[] };
export type WorkingState = ChapterDetail & { draft: WorkingDraftHead | null; sync: ChapterSync };

export type EditorWorkingState = WorkingState & { editor_document: EditorDocument | null };

export type EditorLineageState = EditorWorkingState & { paragraph_lineage: ParagraphLineage | null };

export function getWorkingState(pool: Pool, owner: string, id: string): Promise<WorkingState>;
export function getWorkingState(pool: Pool, owner: string, id: string, editorDocument: boolean): Promise<WorkingState | EditorWorkingState>;
export function getWorkingState(pool: Pool, owner: string, id: string, editorDocument: "editor-lineage"): Promise<EditorLineageState>;

export function getWorkingState(pool: Pool, owner: string, id: string, editorDocument: boolean | "editor-lineage"): Promise<WorkingState | EditorWorkingState | EditorLineageState>;
export function getWorkingState(pool: Pool, owner: string, id: string, editorDocument: boolean | "editor-lineage" = false): Promise<WorkingState | EditorWorkingState | EditorLineageState> {
  const lineageView = editorDocument === "editor-lineage";
  return transaction(pool, readOnlyTransaction, async (client) => {
    if (!await findOwnedChapter(client, owner, id)) throw new AppError(404, "not_found", "Chapter not found");
    const detail = await readChapterDetail(client, id);
    const head = editorDocument ? (await client.query<DraftHead & { editor_document: unknown; paragraph_lineage?: unknown }>(
      "SELECT base_version, revision, content, axis_segment(content) AS blocks, editor_document" +
      (lineageView ? ", paragraph_lineage" : "") + " FROM chapter_drafts WHERE chapter_id = $1", [id],
    )).rows[0] : undefined;
    const draft = editorDocument ? (head ? {
      base_version: head.base_version, revision: head.revision, content: head.content,
      blocks: head.blocks.map(({ ordinal, kind, text }) => ({ ordinal, kind, text })),
    } : null) : await readDraftHead(client, id);
    if (draft !== null && draft.base_version !== detail.version?.id) throw new Error("Invalid draft base");
    const sync = await readChapterSync(client, id);
    let admitted: EditorDocument | null = null;
    if (head && draft && head.editor_document !== null) {
      try { admitted = validateEditorDocument(head.editor_document, draft.content, draft.blocks); }
      catch { throw new Error("Invalid persisted draft editor document"); }
    }
    let lineage: ParagraphLineage | null = null;
    if (lineageView && head && head.paragraph_lineage !== null) {
      try {
        if (admitted === null) throw new Error("Missing persisted document");
        lineage = validateParagraphLineage(head.paragraph_lineage, admitted);
        if (lineage === null) throw new Error("Empty persisted lineage");
      } catch { throw new Error("Invalid persisted draft paragraph lineage"); }
    }
    return { ...detail, sync, ...(editorDocument ? { editor_document: admitted } : {}),
      ...(lineageView ? { paragraph_lineage: lineage } : {}), draft: draft === null ? null : {
      ...draft, blocks: projectDraftBlockUids(detail.version!.content, draft.content, detail.blocks, draft.blocks),
    } };
  });
}
