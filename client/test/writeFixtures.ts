import type { ChapterDetail, ChapterSync, DraftDetail, EditorDocument, EditorWorkingState, VersionWritten, WorkingState, WriteOperation, WriteResult } from "../src/api/types";
import type { Call } from "./helpers";

type Response = { status: number; body: unknown };
type Reply = Response | "network";
type HandlerReply = Reply | ((call: Call, n: number) => Reply | Promise<Reply>);

export function workingState(chapter: ChapterDetail, head?: Pick<DraftDetail, "draft" | "sync">): WorkingState {
  const active_version_id = head?.sync && head.sync.state !== "draft_only"
    ? chapter.active_version_id ?? chapter.version?.id ?? null : chapter.active_version_id;
  const sync: ChapterSync = head?.sync ?? (active_version_id === null ? { state: "draft_only", same: false }
    : active_version_id === chapter.version?.id ? { state: "in_book", same: true } : { state: "edited", same: false });
  const raw = head?.draft;
  const counts = (rows: { kind: string; text: string }[]) => {
    const map = new Map<string, number>();
    for (const row of rows) if (row.kind === "paragraph") map.set(row.text, (map.get(row.text) ?? 0) + 1);
    return map;
  };
  const stored = counts(chapter.blocks), headCounts = counts(raw?.blocks ?? []);
  const draft = raw ? { ...raw, blocks: raw.blocks.map(b => {
    const match = chapter.blocks.find(s => s.kind === "paragraph" && s.text === b.text &&
      (raw.content === chapter.version?.content ? s.ordinal === b.ordinal : stored.get(b.text) === 1 && headCounts.get(b.text) === 1));
    return { ...b, block_uid: b.kind === "paragraph" ? match?.block_uid ?? null : null };
  }) } : null;
  return { ...chapter, active_version_id, draft, sync };

}

export const workingPath = (path: string) => path + "/working-state?view=editor-document";
export function editorWorkingState(chapter: ChapterDetail, head?: Pick<DraftDetail, "draft" | "sync"> & {editor_document?: EditorDocument | null}): EditorWorkingState {
  return {...workingState(chapter,head),editor_document:head?.editor_document ?? null};
}

export function workingRead(path: string, chapter: HandlerReply, head?: HandlerReply) {
  const reply = async (call: Call, n: number): Promise<Reply> => {
    const detail = typeof chapter === "function" ? await chapter(call, n) : chapter;
    if (detail === "network" || detail.status !== 200 || !detail.body) return detail;
    const draft = typeof head === "function" ? await head(call, n) : head;
    if (draft === "network" || (draft && draft.status !== 200)) return draft;
    const state = editorWorkingState(detail.body as ChapterDetail, draft?.body as (DraftDetail & {editor_document?:EditorDocument|null}) | undefined);
    if (draft && (!draft.body || typeof draft.body !== "object" || !("draft" in draft.body))) {
      return { status: 200, body: { ...state, draft: undefined } };
    }
    return { status: 200, body: state };
  };
  return { method: "GET", path: workingPath(path), reply };
}

export function writeResult(call: Call, written: VersionWritten & { checkpoint_version_id?: string | null }): WriteResult {
  const body = call.body as { request_id: string; version_id?: string };
  const last = call.path.split("/").at(-1);
  const operation: WriteOperation = last === "restore" ? "restore" : last === "send" ? "send" : last === "keep-mine" ? "keep_mine" : "save";
  const source = operation === "send" ? "send" : operation === "restore" ? "restore" : "draft_edit";
  const active = written.active_version_id;
  const sync = written.sync ?? (active === null ? { state: "draft_only", same: false }
    : active === written.version.id ? { state: "in_book", same: true } : { state: "edited", same: false });
  return {
    chapter: written.chapter, version: { ...written.version, source }, request_id: body.request_id, operation,
    ...(operation === "save" ? { sync } : {}),
    active_version_id: active, source_version_id: body.version_id ?? null, checkpoint_version_id: written.checkpoint_version_id ?? null,
    current: { version_id: written.version.id, revision: 0, active_version_id: active, sync },
  };
}

export function writeResponse(call: Call, response: Reply): Reply {
  if (response === "network" || response.status !== 201) return response;
  return { status: 201, body: writeResult(call, response.body as VersionWritten) };
}

export const receiptPath = (chapterPath: string, requestId: string) => chapterPath + "/write-receipts/" + requestId;
export const receiptRoute = /\/write-receipts\/[0-9a-f-]+$/;
