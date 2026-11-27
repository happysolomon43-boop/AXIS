import { ApiError, request } from "./http";
import { exactObject, integer, orderedBlocks, revision, uuidV4, validChapter, validSync, validVersionRow, validWorkingState, versionId } from "./validation";
import type { SnapshotLifecycle, SnapshotLabelAction, SnapshotLabelResult, CaptureRequest, CaptureResult, ChapterCreated, ChapterDetail, ChapterHistory, ChapterListItem, ChapterSync, NamedSnapshot, DraftDetail, DraftWritten, PullBackRequest, PullBackWritten, SeriesRow, SeriesTree, VersionText, WorkingState, WriteOperation, WriteRequest, WriteResult } from "./types";

export function listSeries(): Promise<SeriesRow[]>;
export function listSeries(expectedSuccessStatus: 200): Promise<SeriesRow[]>;
export async function listSeries(expectedSuccessStatus?: 200): Promise<SeriesRow[]> {
  if (expectedSuccessStatus === 200) {
    const result = await request<{ series: SeriesRow[] }>("GET", "/series", undefined, 200);
    // Preserve an unusable list for the opening consumer's BC5 validation.
    return result?.series;
  }
  const result = await request<{ series: SeriesRow[] }>("GET", "/series");
  return result.series;
}

export function createSeries(title: string): Promise<SeriesTree> {
  return request("POST", "/series", { title });
}

export function getSeries(id: string): Promise<SeriesTree>;
export function getSeries(id: string, expectedSuccessStatus: 200): Promise<SeriesTree>;
export function getSeries(id: string, expectedSuccessStatus?: 200): Promise<SeriesTree> {
  const path = `/series/${encodeURIComponent(id)}`;
  return expectedSuccessStatus === 200 ? request("GET", path, undefined, 200) : request("GET", path);
}

export async function listBookChapters(bookId: string, expectedSuccessStatus?: 200): Promise<ChapterListItem[]> {
  const path = `/books/${encodeURIComponent(bookId)}/chapters`;
  const result = expectedSuccessStatus === 200 ? await request<{ chapters: ChapterListItem[] }>("GET", path, undefined, 200) : await request<{ chapters: ChapterListItem[] }>("GET", path);
  return result.chapters;
}

export function createChapter(bookId: string, content: string): Promise<ChapterCreated> {
  return request("POST", `/books/${encodeURIComponent(bookId)}/chapters`, { content });
}

export function getChapter(id: string, expectedSuccessStatus?: 200): Promise<ChapterDetail> {
  const path = `/chapters/${encodeURIComponent(id)}`;
  return expectedSuccessStatus === 200 ? request("GET", path, undefined, 200) : request("GET", path);
}

export function writeChapter(chapter: string, book: string, operation: Exclude<WriteOperation, "restore">, body: WriteRequest): Promise<WriteResult> {
  const path = operation === "save" ? "versions" : operation === "keep_mine" ? "keep-mine" : "send";
  return postChapterWrite(chapter, path, body, { chapter, book, operation, requestId: body.request_id, parent: body.parent_version });
}

export async function getWorkingState(chapter: string, book?: string): Promise<WorkingState> {
  const result = await request<unknown>("GET", `/chapters/${encodeURIComponent(chapter)}/working-state`, undefined, 200);
  if (!validWorkingState(result, chapter) || (book !== undefined && result.chapter.book_id !== book)) {
    throw new ApiError(200, "unreadable");
  }
  return result;
}

export function getDraft(id: string, expectedSuccessStatus?: 200): Promise<DraftDetail> {
  const path = `/chapters/${encodeURIComponent(id)}/draft`;
  return expectedSuccessStatus === 200 ? request("GET", path, undefined, 200) : request("GET", path);
}

export async function getDraftSync(chapterId: string): Promise<ChapterSync | null> {
  const result = await request<unknown>("GET", `/chapters/${encodeURIComponent(chapterId)}/draft?view=sync`);
  return exactObject(result, ["sync"]) && validSync(result.sync) ? result.sync : null;
}

export function putDraft(chapterId: string, content: string, baseVersion: string, baseRevision: number): Promise<DraftWritten> {
  return request("PUT", `/chapters/${encodeURIComponent(chapterId)}/draft`, {
    content, base_version: baseVersion, base_revision: baseRevision,
  });
}

export function getHistory(chapterId: string): Promise<ChapterHistory> {
  return request("GET", `/chapters/${encodeURIComponent(chapterId)}/history`);
}

export async function getVersion(chapter: string, id: string, book?: string): Promise<VersionText> {
  const result = await request<unknown>("GET", `/chapters/${encodeURIComponent(chapter)}/versions/${encodeURIComponent(id)}`, undefined, 200);
  if (!exactObject(result, ["chapter", "version", "blocks"]) || !validChapter(result.chapter, chapter, book)
      || !validVersionRow(result.version, chapter) || result.version.id !== id || !orderedBlocks(result.blocks)
      || !result.blocks.every(block => exactObject(block, ["ordinal", "kind", "text"]))) {
    throw new ApiError(200, "unreadable");
  }
  return { chapter: result.chapter, version: result.version, blocks: result.blocks };
}

export type ExpectedWrite = {
  chapter: string; book: string; operation: WriteOperation; requestId: string; parent?: string; source?: string;
};

function matchesWrite(value: unknown, expected: ExpectedWrite): value is WriteResult {
  if (!exactObject(value, ["chapter", "version", "active_version_id", "request_id", "operation",
    "source_version_id", "checkpoint_version_id", "current", ...(expected.operation === "save" ? ["sync"] : [])])) return false;
  const { version, active_version_id, current, source_version_id, checkpoint_version_id } = value;
  if (!validChapter(value.chapter, expected.chapter, expected.book) || !validVersionRow(version, expected.chapter)
      || !uuidV4(value.request_id) || value.request_id !== expected.requestId || value.operation !== expected.operation
      || !(active_version_id === null || versionId(active_version_id))
      || !exactObject(current, ["version_id", "revision", "active_version_id", "sync"])
      || !versionId(current.version_id) || !revision(current.revision)
      || !(current.active_version_id === null || versionId(current.active_version_id)) || !validSync(current.sync)
      || (current.active_version_id === null) !== (current.sync.state === "draft_only")
      || (expected.parent !== undefined && version.parent_version !== expected.parent)) return false;
  if (expected.operation === "restore") {
    return version.source === "restore" && versionId(source_version_id) && source_version_id === expected.source
      && source_version_id !== version.id && active_version_id !== version.id
      && (checkpoint_version_id === null || (versionId(checkpoint_version_id)
        && checkpoint_version_id !== source_version_id && checkpoint_version_id === version.parent_version));
  }
  if (source_version_id !== null) return false;
  if (checkpoint_version_id !== null && (expected.operation !== "keep_mine"
    || !versionId(checkpoint_version_id) || checkpoint_version_id === version.id
    || checkpoint_version_id === version.parent_version || checkpoint_version_id === active_version_id)) return false;
  if (expected.operation === "save" && (!validSync(value.sync) || value.sync.state !== current.sync.state
      || value.sync.same !== current.sync.same)) return false;
  return expected.operation === "send"
    ? (version.source === "send" || version.source === "reupload") && active_version_id === version.id
    : version.source === "draft_edit" && active_version_id !== version.id;
}

async function postChapterWrite(chapter: string, path: string, body: object, expected: ExpectedWrite): Promise<WriteResult> {
  const result = await request<unknown>("POST", `/chapters/${encodeURIComponent(chapter)}/${path}`, body, [200, 201]);
  if (!matchesWrite(result, expected)) throw new ApiError(201, "unreadable");
  return result;
}

export function restoreVersion(chapter: string, book: string, source: string, requestId: string): Promise<WriteResult> {
  return postChapterWrite(chapter, "restore", { version_id: source, request_id: requestId },
    { chapter, book, operation: "restore", requestId, source });
}

export async function getWriteReceipt(expected: ExpectedWrite): Promise<WriteResult | null> {
  const result = await request<unknown>("GET", `/chapters/${encodeURIComponent(expected.chapter)}/write-receipts/${encodeURIComponent(expected.requestId)}`,
    undefined, 200);
  if (!exactObject(result, ["receipt"])) throw new ApiError(200, "unreadable");
  if (result.receipt === null) return null;
  if (!matchesWrite(result.receipt, expected)) throw new ApiError(200, "unreadable");
  return result.receipt;
}

export function isDefiniteWriteFailure(error: unknown): boolean {
  return error instanceof ApiError && (
    (error.status === 400 && error.code === "validation_failed")
    || (error.status === 401 && error.code === "auth_required")
    || (error.status === 404 && error.code === "not_found")
    || (error.status === 409 && error.code === "write_conflict")
    || (error.status === 413 && error.code === "payload_too_large")
    || (error.status === 415 && error.code === "unsupported_media_type")
  );
}

export async function pullBackChapter(chapterId: string, expectedActiveVersionId?: string): Promise<PullBackWritten> {
  const path = "/chapters/" + encodeURIComponent(chapterId) + "/pull-back";
  const body: PullBackRequest | undefined = expectedActiveVersionId === undefined ? undefined : {expected_active_version_id: expectedActiveVersionId};
  const result = await request<unknown>("POST", path, body, 200);
  if (!exactObject(result, ["chapter", "active_version_id"]) ||
      !exactObject(result.chapter, ["id", "book_id", "order_key"]) ||
      typeof result.chapter.id !== "string" || !/^ch_[0-9a-f]{12}$/.test(result.chapter.id) || result.chapter.id !== chapterId ||
      typeof result.chapter.book_id !== "string" || !/^bk_[0-9a-f]{12}$/.test(result.chapter.book_id) ||
      typeof result.chapter.order_key !== "string" || !/^[0-9]{10}$/.test(result.chapter.order_key) ||
      typeof result.active_version_id !== "string" || !/^ver_[0-9a-f]{12}$/.test(result.active_version_id) ||
      (expectedActiveVersionId !== undefined && result.active_version_id !== expectedActiveVersionId)) {
    throw new ApiError(200, "unreadable");
  }
  return {chapter: {id: result.chapter.id, book_id: result.chapter.book_id, order_key: result.chapter.order_key}, active_version_id: result.active_version_id};
}

export function validNamedSnapshot(value: unknown, chapterId: string, versionId: string): value is NamedSnapshot {
  if (!exactObject(value, ["chapter_id", "version_id", "kind", "name", "l_seq", "pack_pins", "created_at"])) return false;
  const { chapter_id, version_id, kind, name, l_seq, pack_pins, created_at } = value;
  return chapter_id === chapterId && version_id === versionId && kind === "snapshot"
    && typeof name === "string" && name.length > 0
    && integer(l_seq, 1)
    && exactObject(pack_pins, []) && typeof created_at === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(created_at)
    && Number.isFinite(Date.parse(created_at)) && new Date(created_at).toISOString() === created_at;
}

export async function nameSnapshot(seriesId: string, chapterId: string, versionId: string, name?: string): Promise<NamedSnapshot | null> {
  const result = await request<unknown>("POST", `/series/${encodeURIComponent(seriesId)}/named-cuts`, {
    kind: "snapshot", chapter_id: chapterId, version_id: versionId, ...(name === undefined ? {} : { name }),
  });
  return exactObject(result, ["snapshot"]) && validNamedSnapshot(result.snapshot, chapterId, versionId)
    ? result.snapshot : null;
}

function decodeCapture(result: unknown, chapterId: string, requestId: string, base?: string): CaptureResult | null {
  if (!exactObject(result, ["capture"]) || !exactObject(result.capture, ["request_id","snapshot","version","created_version","draft_current","active_version_id","sync"])) return null;
  const c = result.capture;
  if (c.request_id !== requestId || !uuidV4(requestId) ||
    !validVersionRow(c.version, chapterId) || !validNamedSnapshot(c.snapshot, chapterId, c.version.id) ||
    c.snapshot.l_seq !== c.version.l_seq || typeof c.created_version !== "boolean" || typeof c.draft_current !== "boolean" ||
    !(c.active_version_id === null || versionId(c.active_version_id)) || !validSync(c.sync)) return null;
  if (c.created_version && (c.version.source !== "draft_edit" || c.version.parent_version === null || (base !== undefined && c.version.parent_version !== base))) return null;
  return { request_id: requestId, snapshot: c.snapshot, version: c.version, created_version: c.created_version, draft_current: c.draft_current, active_version_id: c.active_version_id, sync: c.sync };
}
export async function captureSnapshot(chapterId: string, body: CaptureRequest): Promise<CaptureResult | null> {
  const {request_id, content, base_version, base_revision, name} = body;
  const result = await request<unknown>("POST", `/chapters/${encodeURIComponent(chapterId)}/snapshots`,
    {request_id, content, base_version, base_revision, ...(name === undefined ? {} : { name })});
  return decodeCapture(result, chapterId, request_id, base_version);
}
export async function getSnapshotCapture(chapterId: string, requestId: string): Promise<CaptureResult | null> {
  const result = await request<unknown>("GET", `/chapters/${encodeURIComponent(chapterId)}/snapshots/${encodeURIComponent(requestId)}`);
  return decodeCapture(result, chapterId, requestId);
}

export function validSnapshotLifecycle(value: unknown): value is SnapshotLifecycle {
  return exactObject(value,["snapshot_id","state_token","previous_token"]) && uuidV4(value.snapshot_id) &&
    uuidV4(value.state_token) && (value.previous_token === null || (uuidV4(value.previous_token) && value.previous_token !== value.state_token));
}
export async function changeSnapshotLabel(chapterId:string, id:string, body:SnapshotLabelAction):Promise<SnapshotLabelResult|null> {
  const {action,snapshot_id,expected_token}=body;
  const result=await request<unknown>("POST", `/chapters/${encodeURIComponent(chapterId)}/versions/${encodeURIComponent(id)}/snapshot-label`,
    {action,snapshot_id,expected_token,...(body.action==="undo"?{name:body.name}:{})});
  if (!exactObject(result,["chapter_id","version_id","snapshot_lifecycle","snapshot","can_name_snapshot"]) ||
    result.chapter_id!==chapterId || result.version_id!==id || !validSnapshotLifecycle(result.snapshot_lifecycle) ||
    result.snapshot_lifecycle.snapshot_id!==snapshot_id || result.snapshot_lifecycle.previous_token!==expected_token ||
    typeof result.can_name_snapshot!=="boolean") return null;
  if (body.action==="remove" ? result.snapshot!==null :
    !validNamedSnapshot(result.snapshot,chapterId,id) || result.snapshot.name!==body.name || result.can_name_snapshot!==false) return null;
  return {chapter_id:chapterId,version_id:id,snapshot_lifecycle:result.snapshot_lifecycle,snapshot:result.snapshot as NamedSnapshot|null,can_name_snapshot:result.can_name_snapshot};
}
