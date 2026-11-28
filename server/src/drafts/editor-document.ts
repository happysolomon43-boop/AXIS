import { AppError } from "../errors.js";
import type { DraftBlock } from "./repository.js";

export type EditorDocument = { kind: DraftBlock["kind"]; text: string; paragraph_id: string | null }[];

function invalid(): never {
  throw new AppError(400, "validation_failed", "Request validation failed", {
    errors: [{ path: "/editor_document", message: "must match the draft text and contain valid paragraph identities" }],
  });
}

function paragraphId(value: unknown): value is string {
  return typeof value === "string" &&
    ((value.length === 14 && /^b_[0-9a-f]{12}$/.test(value)) ||
     (value.length === 39 && /^dp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)));
}

const whitespace = /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/u;

export function validateEditorDocument(candidate: unknown, content: string, segmented: readonly DraftBlock[]): EditorDocument {
  if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 1_000_000) invalid();
  const result: EditorDocument = [], ids = new Set<string>();
  let length = 0;
  for (const item of candidate) {
    if (item === null || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).length !== 3 ||
        !["kind", "text", "paragraph_id"].every(key => Object.prototype.hasOwnProperty.call(item, key))) invalid();
    const { kind, text, paragraph_id } = item;
    if ((kind !== "paragraph" && kind !== "heading" && kind !== "scene_break") ||
        typeof text !== "string" || /[\u0000\uD800-\uDFFF]/u.test(text)) invalid();
    for (const _scalar of text) if (++length > 1_000_000) invalid();
    if (kind === "paragraph") {
      if (!paragraphId(paragraph_id) || ids.has(paragraph_id)) invalid();
      ids.add(paragraph_id);
    } else if (paragraph_id !== null) invalid();
    if (kind === "scene_break" && text !== "---" && text !== "***" && text !== "* * *") invalid();
    result.push({ kind, text, paragraph_id });
  }
  const pieces: string[] = [];
  for (const { kind, text } of result) {
    if (kind === "scene_break") pieces.push(text);
    else if (!whitespace.test(text)) pieces.push(kind === "heading" ? "# " + text : text);
  }
  if (pieces.join("\n\n") === content) return result;
  if (segmented.length === 0) {
    if (result.length === 1 && result[0]!.kind === "paragraph" && result[0]!.text === "") return result;
  } else if (segmented.length === result.length &&
    segmented.every((block, i) => block.kind === result[i]!.kind && block.text === result[i]!.text)) return result;
  return invalid();
}
