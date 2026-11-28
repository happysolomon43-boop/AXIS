import type { ChapterHistory, ChapterListItem, HistoryItem, VersionText, EditorWorkingState } from "../src/api/types";
import type { VersionSource } from "../src/api/validation";
import { chapterA, chaptersPath, createdChapter } from "./helpers";
import { histA, histB, histC } from "./historyFixtures";

export const chapter = { ...createdChapter.chapter, id: "ch_000000000001" };
export const v1 = "ver_000000000001";
export const v2 = "ver_000000000002";
export const v3 = "ver_000000000003";
export const rawV1 = "# Ash\r\n\r\nLyra  waits.\n";
export const rawV2 = "# Ash\n\nLyra waits.";
export const rows: (HistoryItem & { source: VersionSource })[] = [
  { ...histC, id: v3, parent_version: v2, chapter_id: chapter.id, source: "restore", l_seq: 43,
    at: "2026-11-16T11:00:00.000Z", word_count: 0 },
  { ...histB, id: v2, parent_version: v1, chapter_id: chapter.id, source: "send", l_seq: 42,
    at: "2026-11-16T10:00:00.000Z" },
  { ...histA, id: v1, chapter_id: chapter.id, source: "draft_edit", l_seq: 41, at: "2026-11-16T09:00:00.000Z",
    snapshot: { chapter_id: chapter.id, version_id: v1, kind: "snapshot", name: "Before the ash",
      l_seq: 41, pack_pins: {}, created_at: "2026-11-16T09:00:00.000Z" } },
];
export const choices = rows.map(({ id, chapter_id, version_no, source, at, l_seq }) =>
  ({ id, chapter_id, version_no, source, at, l_seq }));
export const history: ChapterHistory = { chapter, versions: rows, active_version_id: v2 };
export const head = "Keep my line.";
export const working: EditorWorkingState = {
  chapter, version: { ...versionFields(rows[0]), content: "" }, active_version_id: v2, blocks: [], scenes: [],
  draft: { base_version: v3, revision: 1, content: head,
    blocks: [{ ordinal: 1, kind: "paragraph", text: head, block_uid: null }] },
  sync: { state: "edited", same: false }, editor_document: null,paragraph_lineage:null,
};
export const binderChapter: ChapterListItem = {
  ...chapterA, ...chapter, title: "Ashfall", version_id: v3, active_version_id: v2, sync: working.sync,
};

function versionFields({ at, word_count, snapshot, ...version }: HistoryItem) {
  return version;
}

export function preview(id: string): VersionText {
  return { chapter, version: versionFields(rows.find(row => row.id === id)!),
    blocks: id === v3 ? [] : [{ ordinal: 1, kind: "heading", text: "Ash" }] };
}

export const chapterPath = `/api/chapters/${chapter.id}`;
export const previewPath = (id: string) => `${chapterPath}/versions/${id}`;
export const textPath = (id: string) => `${previewPath(id)}/text`;
export const text = (id: string, content = id === v1 ? rawV1 : id === v2 ? rawV2 : "") =>
  ({ chapter_id: chapter.id, version_id: id, content });
export const ok = (body: unknown) => ({ status: 200, body });
export const proofRoutes = [
  { method: "GET", path: chaptersPath, reply: ok({ chapters: [binderChapter] }) },
  { method: "GET", path: `${chapterPath}/working-state?view=editor-lineage`, reply: ok(working) },
  { method: "GET", path: `${chapterPath}/history`, reply: ok(history) },
  { method: "GET", path: previewPath(v1), reply: ok(preview(v1)) },
];
