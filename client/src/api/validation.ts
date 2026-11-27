import type { ChapterDetail, ChapterRow, ChapterSync, WorkingDraftHead, VersionBlock, VersionRow, WorkingState } from "./types";

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function matches(value: unknown, pattern: RegExp, length: number): value is string {
  return typeof value === "string" && value.length === length && pattern.test(value);
}
export const versionId = (value: unknown): value is string => matches(value, /^ver_[0-9a-f]{12}$/, 16);
const chapterId = (value: unknown) => matches(value, /^ch_[0-9a-f]{12}$/, 15);
const bookId = (value: unknown) => matches(value, /^bk_[0-9a-f]{12}$/, 15);
const hash = (value: unknown) => matches(value, /^[0-9a-f]{64}$/, 64);
export const uuidV4 = (value: unknown): value is string =>
  matches(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 36);
export function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export const revision = (value: unknown): value is number => integer(value, 0, 2147483647);
function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }

export function validChapter(value: unknown, expectedChapter: string, expectedBook?: string): value is ChapterRow {
  return exactObject(value, ["id", "book_id", "order_key"]) && chapterId(value.id) && value.id === expectedChapter
    && bookId(value.book_id) && (expectedBook === undefined || value.book_id === expectedBook)
    && matches(value.order_key, /^[0-9]{10}$/, 10);
}

const sources = ["draft_edit", "send", "reupload", "restore", "import", "bulk_replace", "checkpoint"];
export function validVersion(value: unknown, expectedChapter: string): value is VersionRow {
  return object(value) && versionId(value.id) && value.chapter_id === expectedChapter && chapterId(value.chapter_id)
    && integer(value.version_no, 1) && integer(value.l_seq, 1) && typeof value.source === "string"
    && sources.includes(value.source) && hash(value.text_hash) && hash(value.hints_hash)
    && (value.parent_version === null || (versionId(value.parent_version) && value.parent_version !== value.id));
}

export function validVersionRow(value: unknown, expectedChapter: string): value is VersionRow {
  return exactObject(value, ["id", "chapter_id", "version_no", "source", "text_hash", "hints_hash", "parent_version", "l_seq"])
    && validVersion(value, expectedChapter);
}

function validBlock(value: unknown): value is VersionBlock {
  return object(value) && integer(value.ordinal, 1) &&
    (value.kind === "paragraph" || value.kind === "heading" || value.kind === "scene_break") && typeof value.text === "string";
}
export function orderedBlocks(value: unknown): value is VersionBlock[] {
  if (!Array.isArray(value)) return false;
  let previous = 0;
  for (const block of value) {
    if (!validBlock(block) || block.ordinal <= previous) return false;
    previous = block.ordinal;
  }
  return true;
}
export function validSync(value: unknown): value is ChapterSync {
  if (!exactObject(value, ["state", "same"]) || typeof value.same !== "boolean") return false;
  return (value.state === "draft_only" && !value.same) || (value.state === "in_book" && value.same)
    || (value.state === "edited" && !value.same) || value.state === "being_revised";
}
function scene(value: unknown): boolean {
  return object(value) && integer(value.ordinal, 1) && hash(value.fingerprint) && integer(value.first_block, 1)
    && integer(value.last_block, value.first_block) && nullableString(value.pov_hint) && nullableString(value.location_hint)
    && nullableString(value.time_hint) && typeof value.time_mode === "string"
    && ["linear", "flashback", "skip", "loop"].includes(value.time_mode);
}
function validChapterDetail(value: unknown, expectedChapter: string): value is ChapterDetail {
  return object(value) && validChapter(value.chapter, expectedChapter)
    && (value.version === null || (object(value.version) && typeof value.version.content === "string"
      && validVersion(value.version, expectedChapter)))
    && (value.active_version_id === null || versionId(value.active_version_id))
    && orderedBlocks(value.blocks) && value.blocks.every((b) => "block_uid" in b && matches(b.block_uid, /^b_[0-9a-f]{12}$/, 14) && "hash" in b && hash(b.hash))
    && Array.isArray(value.scenes) && value.scenes.every(scene);
}
function validHead(value: unknown): value is WorkingDraftHead {
  return exactObject(value, ["base_version", "revision", "content", "blocks"])
    && versionId(value.base_version) && integer(value.revision, 1, 2147483647)
    && typeof value.content === "string" && orderedBlocks(value.blocks)
    && value.blocks.every(b => exactObject(b, ["ordinal", "kind", "text", "block_uid"])
      && (b.block_uid === null || (b.kind === "paragraph" && matches(b.block_uid, /^b_[0-9a-f]{12}$/, 14))));
}
function paragraphCounts(blocks: readonly VersionBlock[]) {
  const counts = new Map<string, number>();
  for (const b of blocks) if (b.kind === "paragraph") counts.set(b.text, (counts.get(b.text) ?? 0) + 1);
  return counts;
}
export function validWorkingState(value: unknown, expectedChapter: string): value is WorkingState {
  if (!exactObject(value, ["chapter", "version", "active_version_id", "blocks", "scenes", "draft", "sync"])) return false;
  const { draft, sync } = value;
  if (!validSync(sync) || (draft !== null && !validHead(draft)) || !validChapterDetail(value, expectedChapter)) return false;
  const { version, blocks, active_version_id, scenes } = value;
  if (active_version_id === null ? sync.state !== "draft_only" : sync.state === "draft_only") return false;
  if (version === null) return draft === null && active_version_id === null && blocks.length === 0 && scenes.length === 0;
  if (!exactObject(version, ["id", "chapter_id", "version_no", "source", "text_hash", "hints_hash", "parent_version", "l_seq", "content"])) return false;
  const byUid = new Map<string, typeof blocks[number]>();
  for (const b of blocks) {
    if (!exactObject(b, ["ordinal", "kind", "text", "block_uid", "hash"]) || byUid.has(b.block_uid)) return false;
    byUid.set(b.block_uid, b);
  }
  if (!scenes.every(s => exactObject(s, ["ordinal", "fingerprint", "first_block", "last_block", "pov_hint", "location_hint", "time_hint", "time_mode"]))) return false;
  if (draft === null) return true;
  if (draft.base_version !== version.id) return false;
  if (draft.content === version.content) {
    return blocks.length === draft.blocks.length && draft.blocks.every((b, i) => {
      const stored = blocks[i]!;
      return b.ordinal === stored.ordinal && b.kind === stored.kind && b.text === stored.text
        && b.block_uid === (b.kind === "paragraph" ? stored.block_uid : null);
    });
  }
  const versionCounts = paragraphCounts(blocks), headCounts = paragraphCounts(draft.blocks), seen = new Set<string>();
  for (const b of draft.blocks) {
    if (b.block_uid === null) continue;
    const stored = byUid.get(b.block_uid);
    if (seen.has(b.block_uid) || !stored || stored.kind !== "paragraph" || stored.text !== b.text
      || versionCounts.get(b.text) !== 1 || headCounts.get(b.text) !== 1) return false;
    seen.add(b.block_uid);
  }
  return true;
}
