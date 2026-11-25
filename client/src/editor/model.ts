import { Schema, type Node } from "prosemirror-model";
import type { BlockRow } from "../api/types";
import { copy } from "../copy";

export type EditorBlock = { kind: "paragraph" | "heading" | "scene_break"; text: string };

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block", content: "text*", whitespace: "pre",
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

export function blocksFromServed(blocks: BlockRow[]): EditorBlock[] {
  return blocks.map(({ kind, text }) => ({ kind, text }));
}

export function blocksToDoc(blocks: EditorBlock[]): Node {
  return schema.nodes.doc.create(null, blocks.length === 0 ? [schema.nodes.paragraph.create()] : blocks.map(({ kind, text }) =>
    kind === "scene_break" ? schema.nodes.scene_break.create({ text }) : schema.nodes[kind].create(null, text ? schema.text(text) : null)));
}

export function docToBlocks(doc: Node): EditorBlock[] {
  const blocks: EditorBlock[] = [];
  doc.forEach((node) => {
    const kind = node.type.name as EditorBlock["kind"];
    blocks.push({ kind, text: kind === "scene_break" ? node.attrs.text : node.textContent });
  });
  return blocks;
}
