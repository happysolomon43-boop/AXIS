import { expect, test } from "vitest";
import { validateEditorDocument } from "../src/drafts/editor-document.js";
import type { DraftBlock } from "../src/drafts/repository.js";

const P = "dp_00000000-0000-4000-8000-000000000001";
const b = "b_000000000002";
const paragraph = (text: string, paragraph_id = P) => ({kind: "paragraph", text, paragraph_id});
const heading = {kind: "heading", text: "North", paragraph_id: null};
const split = [heading, paragraph("Riv", b), paragraph("er.")];
const raw = "# North\n\nRiv\n\ner.";
const segment = (document: typeof split): DraftBlock[] =>
  document.map(({kind,text}, i) => ({kind: kind as DraftBlock["kind"], text, ordinal: i+1}));

test("AC1 preserves split, blank and literal heading representations", () => {
  expect(validateEditorDocument(split,raw,segment(split))).toEqual(split);
  expect(validateEditorDocument([paragraph("")],"",[])).toEqual([paragraph("")]);
  expect(validateEditorDocument([paragraph("# North")],"# North",segment([heading]))).toEqual([paragraph("# North")]);
});
test("AC2 admits the original CRLF companion without normalizing it", () => {
  const doc = [heading,paragraph("River.",b)];
  expect(validateEditorDocument(doc,"# North\r\n\r\nRiver.\n",segment(doc))).toEqual(doc);
  expect(() => validateEditorDocument(doc,"unrelated",segment([paragraph("unrelated")]))).toThrow("Request validation failed");
});
test("AC3 rejects invalid structure, Unicode, IDs and scalar count", () => {
  const invalid = [null, [{...paragraph("a"),extra:true}], [paragraph("\ud800")], [paragraph("\0")],
    [paragraph("a"),paragraph("b")], [{...heading,paragraph_id:P}], [paragraph("a","dp_bad")],
    [{kind:"scene_break",text:"bad",paragraph_id:null}], [paragraph("a".repeat(1_000_001))]];
  for (const value of invalid) {
    try { validateEditorDocument(value,"a",[]); throw new Error("accepted invalid document"); }
    catch (error) { expect(error).toMatchObject({status:400,code:"validation_failed",message:"Request validation failed",
      details:{errors:[{path:"/editor_document",message:"must match the draft text and contain valid paragraph identities"}]}}); }
  }
  const limit = "😀".repeat(1_000_000);
  expect(validateEditorDocument([paragraph(limit)],limit,[])).toEqual([paragraph(limit)]);
});
