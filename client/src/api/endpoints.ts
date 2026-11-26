import { request } from "./http";
import type { ChapterCreated, ChapterDetail, ChapterHistory, ChapterListItem, ChapterSync, DraftDetail, DraftWritten, PullBackWritten, RestoreWritten, SeriesRow, SeriesTree, VersionText, VersionWritten } from "./types";

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
