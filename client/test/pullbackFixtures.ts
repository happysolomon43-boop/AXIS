import type { ChapterListItem, ChapterSync, PullBackWritten } from "../src/api/types";
import { treeA } from "./helpers";

export const pbTree = treeA;

export function pbItem(letter: string, orderKey: string, title: string | null, wordCount: number, sync: ChapterSync): ChapterListItem {
  const versionId = `ver_0000000000${letter}1`;
  return {
    id: `ch_00000000000${letter}`,
    book_id: pbTree.books[0].id,
    order_key: orderKey,
    title,
    word_count: wordCount,
    version_id: versionId,
    active_version_id: sync.state === "draft_only" ? null : versionId,
    sync,
  };
}

const a = pbItem("a", "0000001000", null, 3, { state: "draft_only", same: false });
const b = pbItem("b", "0000002000", null, 3, { state: "in_book", same: true });
const c = pbItem("c", "0000003000", "The Third Bell", 5, { state: "edited", same: false });
const d = pbItem("d", "0000004000", null, 3, { state: "being_revised", same: true });
const e = pbItem("e", "0000005000", null, 4, { state: "being_revised", same: false });

export const pbList = { chapters: [a, b, c, d, e] };
export const pbListAfterB = { chapters: [a, pbItem("b", b.order_key, b.title, b.word_count, { state: "being_revised", same: true }), c, d, e] };
export const pbListAfterC = { chapters: [a, b, pbItem("c", c.order_key, c.title, c.word_count, { state: "being_revised", same: false }), d, e] };

export const pullBackReplyB: { status: number; body: PullBackWritten } = {
  status: 200,
  body: {
    chapter: { id: "ch_00000000000b", book_id: "bk_00000000000a", order_key: "0000002000" },
    active_version_id: "ver_0000000000b1",
  },
};

export const chapterNotFoundEnvelope = {
  status: 404, body: { error: { code: "not_found", message: "Chapter not found", details: null } },
};
export const notInBookEnvelope = {
  status: 409, body: { error: { code: "not_in_book", message: "Chapter has no Book version", details: null } },
};
