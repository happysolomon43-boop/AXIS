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

export function syncChip(item: Pick<ChapterListItem, "version_id" | "active_version_id" | "sync">): string | null {
  if (item.sync === undefined) return versionChip(item);
  switch (item.sync.state) {
    case "draft_only": return copy["binder.sync.draftOnly"];
    case "edited": return copy["binder.sync.edited"];
    case "being_revised": return item.sync.same ? copy["binder.sync.beingRevisedSame"] : copy["binder.sync.beingRevised"];
    default: return null;
  }
}
