import type { BlockRow, ChapterDetail, ChapterListItem, VersionRow, VersionWritten, ChapterCreated } from "../src/api/types";
import { bookA, chapterA as listA, createdChapter } from "./helpers";

export const a = "ver_00000000000a", b = "ver_00000000000b", c = "ver_00000000000c", d = "ver_00000000000d";
export const chapterA = { id: "ch_00000000000a", book_id: bookA.id, order_key: "0000001000" };
export const chapterPath = `/api/chapters/${chapterA.id}`;
export const hash = "0".repeat(64);
export const verRow = (id: string, no: number, parent: string | null): VersionRow => ({
  id, chapter_id: chapterA.id, version_no: no, source: "draft_edit", text_hash: hash, hints_hash: hash, parent_version: parent, l_seq: no,
});
const blocks: BlockRow[] = ([
  ["heading", "Title"], ["paragraph", "One"], ["scene_break", "---"], ["paragraph", "Two"],
] as const).map(([kind, text], i) => ({ block_uid: `b_00000000000${"abcd"[i]}`, ordinal: i + 1, kind, text, hash }));
export const detailEmpty: ChapterDetail = { chapter: chapterA, version: { ...verRow(a, 1, null), content: "" }, active_version_id: null, blocks: [], scenes: [] };
export const detailText: ChapterDetail = {
  chapter: chapterA, version: { ...verRow(b, 2, a), content: "# Title\n\nOne\n\n---\n\nTwo" }, active_version_id: null, blocks,
  scenes: [{ ordinal: 1, first_block: 1, last_block: 2 }, { ordinal: 2, first_block: 4, last_block: 4 }].map((row) => ({
    ...row, fingerprint: hash, pov_hint: null, location_hint: null, time_hint: null, time_mode: "linear" as const,
  })),
};
export const detailSent: ChapterDetail = { ...detailText, active_version_id: b };
export const writtenC = (active: string | null): VersionWritten => ({ chapter: chapterA, version: verRow(c, 3, b), active_version_id: active });
export const reply = (body: unknown, status = 200) => ({ status, body });
export const chapterList = (items: ChapterListItem[]) => reply({ chapters: items });
export const fourRows: ChapterListItem[] = [
  { ...listA, title: "Title", word_count: 4, version_id: b },
  { ...listA, id: "ch_00000000000b", order_key: "0000002000", title: null, version_id: b, active_version_id: b },
  { ...listA, id: "ch_00000000000c", order_key: "0000003000", word_count: 3404, version_id: d, active_version_id: c },
  { ...listA, id: "ch_00000000000d", order_key: "0000004000", version_id: null },
];
export const createdB: ChapterCreated = {
  chapter: { ...chapterA, id: fourRows[1].id, order_key: fourRows[1].order_key },
  version: { ...createdChapter.version, id: b, chapter_id: fourRows[1].id },
};
