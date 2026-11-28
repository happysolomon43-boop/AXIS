import { AppError } from "../errors.js";
import type { EditorDocument } from "./editor-document.js";

export type ParagraphLineageRecord = { kind: "split" | "merge"; old_id: string; new_id: string };
export type ParagraphLineage = readonly ParagraphLineageRecord[];

function invalid(): never {
  throw new AppError(400, "validation_failed", "Request validation failed", {
    errors: [{path:"/paragraph_lineage",message:"must be sorted lineage records that match the editor document"}],
  });
}

function paragraphId(value: string): boolean {
  return (value.length === 14 && /^b_[0-9a-f]{12}$/.test(value)) ||
    (value.length === 39 && /^dp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
}

function precedes(a: ParagraphLineageRecord, b: ParagraphLineageRecord): boolean {
  return a.kind < b.kind || (a.kind === b.kind &&
    (a.old_id < b.old_id || (a.old_id === b.old_id && a.new_id < b.new_id)));
}

export function validateParagraphLineage(candidate: unknown, document: EditorDocument): ParagraphLineage | null {
  if (!Array.isArray(candidate) || candidate.length > 1_000_000) invalid();
  if (candidate.length === 0) return null;
  const result: ParagraphLineageRecord[] = [];
  for (const item of candidate) {
    if (item === null || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).length !== 3 ||
        !["kind","old_id","new_id"].every(key=>Object.prototype.hasOwnProperty.call(item,key)) ||
        typeof item.kind !== "string" || typeof item.old_id !== "string" || typeof item.new_id !== "string") invalid();
    const {kind,old_id,new_id}=item;
    if (kind !== "split" && kind !== "merge") invalid();
    if (!paragraphId(old_id) || !paragraphId(new_id) || old_id === new_id) invalid();
    result.push({kind,old_id,new_id});
  }
  for (let i=1;i<result.length;i++) if (!precedes(result[i-1]!,result[i]!)) invalid();
  const splits=new Set<string>(), merges=new Set<string>();
  for (const record of result) if (record.kind === "split") {
    if (splits.has(record.new_id)) invalid();
    splits.add(record.new_id);
  }
  for (const record of result) if (record.kind === "merge") {
    if (merges.has(record.old_id)) invalid();
    merges.add(record.old_id);
  }
  const ids=new Set<string>();
  for (const {paragraph_id} of document) if (paragraph_id !== null) ids.add(paragraph_id);
  for (const record of result) {
    if (!ids.has(record.new_id) || (record.kind === "merge" && ids.has(record.old_id))) invalid();
    Object.freeze(record);
  }
  return Object.freeze(result);
}
