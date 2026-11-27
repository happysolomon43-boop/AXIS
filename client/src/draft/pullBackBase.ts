import type { ChapterDetail, DraftDetail } from "../api/types";

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function id(value: unknown, prefix: string): boolean { return typeof value === "string" && new RegExp("^"+prefix+"_[0-9a-f]{12}$").test(value); }
function hash(value: unknown): boolean { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function integer(value: unknown, min: number, max=Number.MAX_SAFE_INTEGER): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value>=min && value<=max; }
function nullableString(value: unknown): boolean { return value===null || typeof value==="string"; }
function chapter(value: unknown, chapterId: string): boolean {
  return object(value) && id(value.id,"ch") && value.id===chapterId && id(value.book_id,"bk") &&
    typeof value.order_key==="string" && /^[0-9]{10}$/.test(value.order_key);
}
function block(value: unknown): boolean {
  return object(value) && integer(value.ordinal,1) && ["paragraph","heading","scene_break"].includes(String(value.kind)) &&
    typeof value.text==="string";
}
function sync(value: unknown): boolean {
  return object(value) && typeof value.same==="boolean" &&
    ((value.state==="draft_only"&&!value.same)||(value.state==="in_book"&&value.same)||(value.state==="edited"&&!value.same)||value.state==="being_revised");
}
function version(value: unknown, chapterId: string): boolean {
  return object(value) && id(value.id,"ver") && value.chapter_id===chapterId && integer(value.version_no,1) &&
    typeof value.source==="string" && ["draft_edit","send","reupload","restore","import","bulk_replace","checkpoint"].includes(value.source) &&
    hash(value.text_hash) && hash(value.hints_hash) && (value.parent_version===null||id(value.parent_version,"ver")) &&
    integer(value.l_seq,1) && typeof value.content==="string";
}
function scene(value: unknown): boolean {
  return object(value) && integer(value.ordinal,1) && hash(value.fingerprint) && integer(value.first_block,1) &&
    integer(value.last_block,Number(value.first_block)) && nullableString(value.pov_hint) && nullableString(value.location_hint) &&
    nullableString(value.time_hint) && typeof value.time_mode==="string" && ["linear","flashback","skip","loop"].includes(value.time_mode);
}

export function validChapterBase(value: unknown, chapterId: string): value is ChapterDetail {
  return object(value) && chapter(value.chapter,chapterId) && (value.version===null||version(value.version,chapterId)) &&
    (value.active_version_id===null||id(value.active_version_id,"ver")) &&
    Array.isArray(value.blocks) && value.blocks.every(b=>object(b)&&block(b)&&id(b.block_uid,"b")&&hash(b.hash)) &&
    Array.isArray(value.scenes) && value.scenes.every(scene);
}
export function validDraftBase(value: unknown, chapterId: string): value is DraftDetail {
  return object(value) && chapter(value.chapter,chapterId) && (value.sync===undefined||sync(value.sync)) &&
    (value.draft===null||(object(value.draft)&&id(value.draft.base_version,"ver")&&integer(value.draft.revision,1,2147483647)&&
      typeof value.draft.content==="string"&&Array.isArray(value.draft.blocks)&&value.draft.blocks.every(block)));
}
