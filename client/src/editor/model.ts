import { Schema, type Node } from "prosemirror-model";
import type { BlockRow, DraftBlock, WorkingDraftBlock, EditorDocument } from "../api/types";
import { copy } from "../copy";

export type EditorBlock = { kind: "paragraph" | "heading" | "scene_break"; text: string; block_uid?: string | null };

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block", content: "text*", whitespace: "pre", attrs: { block_uid: { default: null } },
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", { "data-block": "paragraph" }, 0],
    },
    heading: {
      group: "block", content: "text*", whitespace: "pre", defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((n) => ({ tag: `h${n}` })),
      toDOM: () => ["h2", { "data-block": "heading" }, 0],
    },
    scene_break: {
      group: "block", atom: true, selectable: true, attrs: { text: { default: "* * *" } },
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["hr", { "data-block": "scene_break", "aria-label": copy["editor.sceneBreak"] }],
    },
    text: { group: "inline" },
  },
});

export function serializeBlocks(blocks: EditorBlock[]): string {
  const pieces: string[] = [];
  for (const { kind, text } of blocks) {
    if (kind === "scene_break") {
      pieces.push(text === "---" || text === "***" || text === "* * *" ? text : "* * *");
    } else if (!/^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/u.test(text)) {
      pieces.push(kind === "heading" ? `# ${text}` : text);
    }
  }
  return pieces.join("\n\n");
}

export function canonicalParagraphUid(value: unknown): value is string {
  return typeof value === "string" && value.length === 14 && /^b_[0-9a-f]{12}$/.test(value);
}

export function blocksFromServed(blocks: readonly (BlockRow | WorkingDraftBlock | DraftBlock)[]): EditorBlock[] {
  return blocks.map(b => b.kind === "paragraph"
    ? { kind: b.kind, text: b.text, block_uid: "block_uid" in b && canonicalParagraphUid(b.block_uid) ? b.block_uid : null }
    : { kind: b.kind, text: b.text });
}

export function blocksToDoc(blocks: EditorBlock[]): Node {
  return schema.nodes.doc.create(null, blocks.length === 0 ? [schema.nodes.paragraph.create()] : blocks.map(({ kind, text, block_uid }) =>
    kind === "scene_break" ? schema.nodes.scene_break.create({ text }) : schema.nodes[kind].create(kind === "paragraph" ? { block_uid: canonicalParagraphUid(block_uid) ? block_uid : null } : null, text ? schema.text(text) : null)));
}

export function docToBlocks(doc: Node): EditorBlock[] {
  const blocks: EditorBlock[] = [];
  doc.forEach((node) => {
    const kind = node.type.name as EditorBlock["kind"];
    blocks.push({ kind, text: kind === "scene_break" ? node.attrs.text : node.textContent });
  });
  return blocks;
}

export function sameContentDoc(a: Node, b: Node): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) {
    const x = a.child(i), y = b.child(i);
    if (x.type !== y.type) return false;
    if (x.type.name === "scene_break") { if (x.attrs.text !== y.attrs.text) return false; }
    else if (x.type.name === "paragraph" || x.type.name === "heading") { if (x.textContent !== y.textContent) return false; }
    else return false;
  }
  return true;
}

export function blocksFromEditorDocument(document: EditorDocument): EditorBlock[] {
  return document.map(({kind,text,paragraph_id}) => kind === "paragraph" ? {kind,text,block_uid:paragraph_id} : {kind,text});
}

export function editorDocumentToDoc(document: EditorDocument): Node {
  return schema.nodes.doc.create(null, document.map(({kind,text,paragraph_id}) =>
    kind === "scene_break" ? schema.nodes.scene_break.create({text}) :
      schema.nodes[kind].create(kind === "paragraph" ? {block_uid:paragraph_id} : null, text ? schema.text(text) : null)));
}

export function docToEditorDocument(doc: Node): EditorDocument {
  const result: EditorDocument = [];
  doc.forEach(node => {
    const kind = node.type.name as EditorBlock["kind"];
    result.push({kind,text:kind === "scene_break" ? node.attrs.text : node.textContent,paragraph_id:kind === "paragraph" ? node.attrs.block_uid : null});
  });
  return result;
}

export function sameEditorDocument(a: EditorDocument, b: EditorDocument): boolean {
  return a.length === b.length && a.every((item,i) => item.kind === b[i]!.kind && item.text === b[i]!.text && item.paragraph_id === b[i]!.paragraph_id);
}
