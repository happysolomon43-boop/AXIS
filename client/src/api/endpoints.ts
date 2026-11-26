import { request } from "./http";
import type { SnapshotLifecycle, SnapshotLabelAction, SnapshotLabelResult, CaptureRequest, CaptureResult, VersionRow, ChapterCreated, ChapterDetail, ChapterHistory, ChapterListItem, ChapterSync, NamedSnapshot, DraftDetail, DraftWritten, PullBackWritten, RestoreWritten, SeriesRow, SeriesTree, VersionText, VersionWritten } from "./types";

export async function listSeries(): Promise<SeriesRow[]> {
  const result = await request<{ series: SeriesRow[] }>("GET", "/series");
  return result.series;
}

export function createSeries(title: string): Promise<SeriesTree> {
  return request("POST", "/series", { title });
}

export function getSeries(id: string): Promise<SeriesTree> {
  return request("GET", `/series/${encodeURIComponent(id)}`);
}

export async function listBookChapters(bookId: string): Promise<ChapterListItem[]> {
  const result = await request<{ chapters: ChapterListItem[] }>(
    "GET", `/books/${encodeURIComponent(bookId)}/chapters`,
  );
  return result.chapters;
}

export function createChapter(bookId: string, content: string): Promise<ChapterCreated> {
  return request("POST", `/books/${encodeURIComponent(bookId)}/chapters`, { content });
}

export function getChapter(id: string): Promise<ChapterDetail> {
  return request("GET", `/chapters/${encodeURIComponent(id)}`);
}

export function saveVersion(chapterId: string, content: string, parentVersion: string): Promise<VersionWritten> {
  return request("POST", `/chapters/${encodeURIComponent(chapterId)}/versions`, { content, parent_version: parentVersion });
}

export function sendChapter(chapterId: string, content: string, parentVersion: string): Promise<VersionWritten> {
  return request("POST", `/chapters/${encodeURIComponent(chapterId)}/send`, { content, parent_version: parentVersion });
}

export function getDraft(id: string): Promise<DraftDetail> {
  return request("GET", `/chapters/${encodeURIComponent(id)}/draft`);
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export async function getDraftSync(chapterId: string): Promise<ChapterSync | null> {
  const result = await request<unknown>("GET", `/chapters/${encodeURIComponent(chapterId)}/draft?view=sync`);
  if (!exactObject(result, ["sync"]) || !exactObject(result.sync, ["state", "same"])) return null;
  const { state, same } = result.sync;
  if (typeof same !== "boolean") return null;
  if ((state === "draft_only" && !same) || (state === "in_book" && same)
      || (state === "edited" && !same) || state === "being_revised") {
    return { state, same };
  }
  return null;
}

export function putDraft(chapterId: string, content: string, baseVersion: string, baseRevision: number): Promise<DraftWritten> {
  return request("PUT", `/chapters/${encodeURIComponent(chapterId)}/draft`, {
    content, base_version: baseVersion, base_revision: baseRevision,
  });
}

export function getHistory(chapterId: string): Promise<ChapterHistory> {
  return request("GET", `/chapters/${encodeURIComponent(chapterId)}/history`);
}

export function getVersion(chapterId: string, versionId: string): Promise<VersionText> {
  return request("GET", `/chapters/${encodeURIComponent(chapterId)}/versions/${encodeURIComponent(versionId)}`);
}

export function restoreVersion(chapterId: string, versionId: string): Promise<RestoreWritten> {
  return request("POST", `/chapters/${encodeURIComponent(chapterId)}/restore`, { version_id: versionId });
}

export function pullBackChapter(chapterId: string): Promise<PullBackWritten> {
  return request("POST", `/chapters/${encodeURIComponent(chapterId)}/pull-back`);
}

export function validNamedSnapshot(value: unknown, chapterId: string, versionId: string): value is NamedSnapshot {
  if (!exactObject(value, ["chapter_id", "version_id", "kind", "name", "l_seq", "pack_pins", "created_at"])) return false;
  const { chapter_id, version_id, kind, name, l_seq, pack_pins, created_at } = value;
  return chapter_id === chapterId && version_id === versionId && kind === "snapshot"
    && typeof name === "string" && name.length > 0
    && typeof l_seq === "number" && Number.isInteger(l_seq) && l_seq > 0
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

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const versionId = (v: unknown): v is string => typeof v === "string" && v.length === 16 && /^ver_[0-9a-f]{12}$/.test(v);
const validChapterId = (v: unknown): v is string => typeof v === "string" && v.length === 15 && /^ch_[0-9a-f]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && v.length === 64 && /^[0-9a-f]{64}$/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const sources = ["draft_edit","send","reupload","restore","import","bulk_replace","checkpoint"];
function captureVersion(value: unknown, chapterId: string): value is VersionRow {
  if (!exactObject(value, ["id","chapter_id","version_no","source","text_hash","hints_hash","parent_version","l_seq"])) return false;
  return versionId(value.id) && value.chapter_id === chapterId && validChapterId(value.chapter_id)
    && positive(value.version_no) && positive(value.l_seq) && typeof value.source === "string" && sources.includes(value.source)
    && hash(value.text_hash) && hash(value.hints_hash) && (value.parent_version === null || versionId(value.parent_version));
}
function validCaptureSync(value: unknown): value is ChapterSync {
  if (!exactObject(value, ["state","same"]) || typeof value.same !== "boolean") return false;
  return (value.state === "draft_only" && !value.same) || (value.state === "in_book" && value.same)
    || (value.state === "edited" && !value.same) || value.state === "being_revised";
}
function decodeCapture(result: unknown, chapterId: string, requestId: string, base?: string): CaptureResult | null {
  if (!exactObject(result, ["capture"]) || !exactObject(result.capture, ["request_id","snapshot","version","created_version","draft_current","active_version_id","sync"])) return null;
  const c = result.capture;
  if (c.request_id !== requestId || requestId.length !== 36 || !uuidV4.test(requestId) ||
    !captureVersion(c.version, chapterId) || !validNamedSnapshot(c.snapshot, chapterId, c.version.id) ||
    c.snapshot.l_seq !== c.version.l_seq || typeof c.created_version !== "boolean" || typeof c.draft_current !== "boolean" ||
    !(c.active_version_id === null || versionId(c.active_version_id)) || !validCaptureSync(c.sync)) return null;
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

const validUuid = (v: unknown): v is string => typeof v === "string" && v.length === 36 && uuidV4.test(v);
export function validSnapshotLifecycle(value: unknown): value is SnapshotLifecycle {
  return exactObject(value,["snapshot_id","state_token","previous_token"]) && validUuid(value.snapshot_id) &&
    validUuid(value.state_token) && (value.previous_token === null || (validUuid(value.previous_token) && value.previous_token !== value.state_token));
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
