import tokens from "../src/styles/tokens.css?raw";
import { expect } from "vitest";
import type { ChapterHistory, ChapterRow, HistoryItem, VersionBlock, VersionText } from "../src/api/types";

export const chapterA: ChapterRow = { id: "ch_00000000000a", book_id: "bk_00000000000a", order_key: "0000001000" };
const hash = "0".repeat(64);
const versionA = "ver_00000000000a";
const versionB = "ver_00000000000b";
const versionC = "ver_00000000000c";
const versionD = "ver_00000000000d";

export const histA: HistoryItem = {
  id: versionA, chapter_id: chapterA.id, version_no: 1, source: "draft_edit", text_hash: hash,
  hints_hash: hash, parent_version: null, l_seq: 1, at: "2026-10-21T18:30:00.000Z", word_count: 2,
};
export const histB: HistoryItem = {
  ...histA, id: versionB, version_no: 2, parent_version: versionA, l_seq: 2,
  at: "2026-10-22T09:05:00.000Z", word_count: 3,
};
export const histC: HistoryItem = {
  ...histB, id: versionC, version_no: 3, source: "send", parent_version: versionB, l_seq: 3,
  at: "2026-10-23T16:12:00.000Z",
};
export const histD: HistoryItem = {
  ...histC, id: versionD, version_no: 4, source: "reupload", parent_version: versionC, l_seq: 4,
  at: "2026-10-24T10:00:00.000Z", word_count: 5,
};

export const historyTwo: ChapterHistory = { chapter: chapterA, active_version_id: null, versions: [histB, histA] };
export const historyThree: ChapterHistory = { chapter: chapterA, active_version_id: versionC, versions: [histC, histB, histA] };
export const historyFour: ChapterHistory = { chapter: chapterA, active_version_id: versionD, versions: [histD, histC, histB, histA] };
export const historyNoActive: ChapterHistory = { ...historyThree, active_version_id: null };
export const historyNone: ChapterHistory = { ...historyTwo, versions: [] };

function versionText({ at: _at, word_count: _count, ...version }: HistoryItem, blocks: VersionBlock[]): VersionText {
  return { chapter: chapterA, version, blocks };
}

export const versionTextA = versionText(histA, [
  { ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "One" },
]);
export const versionTextB = versionText(histB, [
  ...versionTextA.blocks, { ordinal: 3, kind: "scene_break", text: "---" },
  { ordinal: 4, kind: "paragraph", text: "Two" },
]);
export const versionTextC = versionText(histC, [
  ...versionTextB.blocks.slice(0, 3), { ordinal: 4, kind: "paragraph", text: "Two!" },
]);
export const versionTextD = versionText(histD, [
  ...versionTextC.blocks, { ordinal: 5, kind: "paragraph", text: "Three" },
  { ordinal: 6, kind: "paragraph", text: "Four" },
]);

export const versionNotFoundEnvelope = {
  status: 404, body: { error: { code: "not_found", message: "Version not found", details: null } },
};
export const internalEnvelope = {
  status: 500, body: { error: { code: "internal", message: "Internal error", details: null } },
};

export const historyPath = `/api/chapters/${chapterA.id}/history`;
export const versionPath = (id: string) => `/api/chapters/${chapterA.id}/versions/${id}`;

export const permittedHistoryTokens = new Set([
  "color-surface-shell", "color-text-primary", "color-text-secondary", "color-text-tertiary",
  "color-border-hair", "color-pencil-tint", "space-2", "space-3", "space-4", "space-5", "space-8",
  "radius-1", "radius-2", "size-strip", "size-drawer", "size-drawer-header", "z-overlay", "shadow-overlay",
  "type-family-mono", "type-family-page-literary",
  ...["caption", "small", "body", "lead", "title-s", "mono"]
    .flatMap((step) => [`type-${step}-size`, `type-${step}-lh`]),
]);

export function historyColors() {
  const expected = {
    light: ["#ECEBE6", "#1B1C1E", "#4A4D52", "#62656A", "#D3D1CA", "#DCE7F2"],
    dark: ["#0B0C0E", "#D9D6CD", "#A9A79F", "#94938E", "#26292D", "#1B2733"],
    sepia: ["#D8CAAD", "#2B2418", "#4F4636", "#594F3D", "#BFAF8F", "#C8D0D2"],
  };
  const names = ["surface-shell", "text-primary", "text-secondary", "text-tertiary", "border-hair", "pencil-tint"];
  return Object.entries(expected).map(([theme, hex]) => {
    const css = tokens.split(`:root[data-theme="${theme}"] {`)[1].split("}")[0];
    const colors = names.map((name) => css.match(new RegExp(`--ax-color-${name}:\\s*(#[0-9a-f]{6});`, "i"))?.[1] ?? "");
    expect(colors, theme).toEqual(hex);
    const [room, primary, secondary, tertiary, , pencil] = colors;
    return { theme, room, primary, secondary, tertiary, pencil };
  });
}
