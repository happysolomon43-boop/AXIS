import { expect, test } from "vitest";
import { DOMParser, DOMSerializer } from "prosemirror-model";
import { blocksFromServed, blocksToDoc, docToBlocks, sameContentDoc, schema, serializeBlocks } from "../src/editor/model";
import { equal, changed, uid } from "./paragraphIdentityFixtures";
test("AXB-0139 AC2/3/4 paragraph hints are model-only and do not change content equality",()=>{
 const doc=blocksToDoc(blocksFromServed(equal.draft!.blocks));
 expect(doc.child(1).attrs.block_uid).toBe(uid(2));expect(doc.child(0).attrs).not.toHaveProperty("block_uid");
 expect(doc.child(4).attrs).not.toHaveProperty("block_uid");
 expect(blocksToDoc(blocksFromServed(changed.draft!.blocks)).child(1).attrs.block_uid).toBe(uid(6));
 expect(blocksToDoc([]).firstChild!.attrs.block_uid).toBeNull();
 expect(blocksToDoc([{kind:"paragraph",text:"River.",block_uid:"local_p_7"}]).firstChild!.attrs.block_uid).toBeNull();
 const plain=blocksToDoc(docToBlocks(doc));expect(doc.eq(plain)).toBe(false);expect(sameContentDoc(doc,plain)).toBe(true);
 expect(serializeBlocks(docToBlocks(doc))).toBe(equal.version!.content);
 const html=document.createElement("div");html.innerHTML='<p data-block-uid="'+uid(2)+'">River.</p><p>Other</p>';
 const parsed=DOMParser.fromSchema(schema).parse(html);expect(parsed.child(0).attrs.block_uid).toBeNull();expect(parsed.child(1).attrs.block_uid).toBeNull();
 html.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));expect(html.querySelector("[data-block-uid]")).toBeNull();expect(html.querySelector("hr")).toHaveAttribute("aria-label","Scene break");
 const p=(text:string)=>({kind:"paragraph" as const,text});
 for(const [a,b] of [[[p("x")],[p("X")]],[[p("x")],[p("x ")]],[[p("x")],[p("x"),p("")]],[[p("x")],[{kind:"heading" as const,text:"x"}]],[[p("x"),p("y")],[p("y"),p("x")]],[[{kind:"scene_break" as const,text:"---"}],[{kind:"scene_break" as const,text:"***"}]]] as const)
  expect(sameContentDoc(blocksToDoc([...a]),blocksToDoc([...b]))).toBe(false);
});
