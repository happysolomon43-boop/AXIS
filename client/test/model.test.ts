import { expect, test } from "vitest";
import { blocksFromServed, blocksToDoc, docToBlocks, schema, serializeBlocks, type EditorBlock } from "../src/editor/model";
import { detailText } from "./d06.fixtures";
const p = (text: string): EditorBlock => ({ kind: "paragraph", text });
const h = (text: string): EditorBlock => ({ kind: "heading", text });
const s = (text: string): EditorBlock => ({ kind: "scene_break", text });

test("AXB-0038 AC1 serializes exact characters, skips whitespace W and preserves served order", () => {
  const cases: [EditorBlock[], string][] = [
    [[], ""], [[p("A")], "A"], [[h("Title"), p("One\ntwo"), s("---"), p("Three")], "# Title\n\nOne\ntwo\n\n---\n\nThree"],
    [[p(""), p("A"), p("  "), p("B"), p("\u3000")], "A\n\nB"], [[h("   "), s("***")], "***"], [[s("x")], "* * *"], [[p("She said “yes”")], "She said “yes”"],
    [[p("\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000")], ""], [[p("\uFEFF")], "\uFEFF"],
  ];
  for (const [blocks, result] of cases) expect(serializeBlocks(blocks)).toBe(result);
  expect(blocksFromServed(detailText.blocks)).toEqual([h("Title"), {...p("One"), block_uid: detailText.blocks[1].block_uid}, s("---"), {...p("Two"), block_uid: detailText.blocks[3].block_uid}]);
  expect(blocksFromServed([...detailText.blocks].reverse())).toEqual([{...p("Two"), block_uid: detailText.blocks[3].block_uid}, s("---"), {...p("One"), block_uid: detailText.blocks[1].block_uid}, h("Title")]);
});

test("AXB-0038 AC2 preserves the three block types, scene markers and document equality", () => {
  const empty = blocksToDoc([]);
  expect(empty.childCount).toBe(1);
  expect(empty.firstChild?.type.name).toBe("paragraph");
  expect(empty.textContent).toBe("");
  expect(docToBlocks(empty)).toEqual([p("")]);
  const blocks = blocksFromServed(detailText.blocks);
  expect(docToBlocks(blocksToDoc(blocks))).toEqual([h("Title"), p("One"), s("---"), p("Two")]);
  expect(docToBlocks(blocksToDoc([s("***"), p("a\nb")]))).toEqual([s("***"), p("a\nb")]);
  expect(blocksToDoc(blocks).eq(blocksToDoc(blocks))).toBe(true);
  expect(Object.keys(schema.nodes)).toEqual(["doc", "paragraph", "heading", "scene_break", "text"]);
  expect(Object.keys(schema.marks)).toEqual([]);
  expect(schema.nodes.paragraph.whitespace).toBe("pre");
  expect(schema.nodes.heading.whitespace).toBe("pre");
});
