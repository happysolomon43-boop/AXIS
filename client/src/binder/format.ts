import type { ChapterListItem } from "../api/types";
import { copy } from "../copy";

export function formatWordCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function chapterRowName(position: number, title: string | null): string {
  return copy["binder.chapterName"](position, title);
}

export function versionChip(item: Pick<ChapterListItem, "version_id" | "active_version_id">): string | null {
  if (item.active_version_id === null) return copy["binder.chipDraftOnly"];
  if (item.active_version_id === item.version_id) return null;
  return copy["binder.chipEdited"];
}
