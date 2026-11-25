import { request } from "./http";
import type { ChapterCreated, ChapterListItem, SeriesRow, SeriesTree } from "./types";

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
