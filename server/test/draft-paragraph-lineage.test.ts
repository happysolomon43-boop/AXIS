import { expect, test } from "vitest";
import { validateParagraphLineage } from "../src/drafts/paragraph-lineage.js";
import type { EditorDocument } from "../src/drafts/editor-document.js";

const O="b_000000000002", U="b_000000000003";
const P="dp_00000000-0000-4000-8000-000000000001";
const Q="dp_00000000-0000-4000-8000-000000000002";
const R="dp_00000000-0000-4000-8000-000000000003";
const heading={kind:"heading",text:"North",paragraph_id:null} as const;
const paragraph=(text:string,paragraph_id:string)=>({kind:"paragraph" as const,text,paragraph_id});
const split=(old_id=O,new_id=P)=>({kind:"split" as const,old_id,new_id});
const merge=(old_id=P,new_id=O)=>({kind:"merge" as const,old_id,new_id});
const splitDoc:EditorDocument=[heading,paragraph("Riv",O),paragraph("er.",P)];
const joinedDoc:EditorDocument=[heading,paragraph("River.",O)];
const secondDoc:EditorDocument=[heading,paragraph("Riv",O),paragraph("er.",Q)];
const invalid=(candidate:unknown,doc=splitDoc)=>{
  try {
    validateParagraphLineage(candidate,doc);
    throw new Error("accepted invalid lineage");
  } catch(error) {
    expect(error).toMatchObject({status:400,code:"validation_failed",message:"Request validation failed",
      details:{errors:[{path:"/paragraph_lineage",message:"must be sorted lineage records that match the editor document"}]}});
  }
};
test("AC1 exact canonical records, frozen copies and empty absence",()=>{
  for (const [candidate,doc] of [[[split()],splitDoc],[[merge()],joinedDoc],[[merge(),split(O,Q)],secondDoc]] as const) {
    const result=validateParagraphLineage(candidate,doc);
    expect(result).toEqual(candidate);
    expect(result).not.toBe(candidate);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result![0])).toBe(true);
    expect(result![0]).not.toBe(candidate[0]);
  }
  expect(validateParagraphLineage([],joinedDoc)).toBeNull();
});
test("AC2 rejects shape, format, membership, duplicates and order",()=>{
  for (const candidate of [
    {},null,[null],[{...split(),extra:true}],[{kind:"split",old_id:O}],
    [{...split(),old_id:42}],[{...split(),kind:"move"}],
    [split("b_00000000000A")],[split(P.replace("-4000-","-3000-"))],
    [split(P,P)],[split(O,R)],[merge(Q,R)],[merge()],
    [split(O,P),split(U,P)],[merge(Q,O),merge(Q,P)],
    [split(),merge(Q)],[split(),split()],
  ]) invalid(candidate);
});
test("AC3 enforces the one-million-record bound",()=>{
  const records=Array.from({length:1_000_000},(_,i)=>merge("dp_00000000-0000-4000-8000-"+i.toString(16).padStart(12,"0"),O));
  invalid([...records,merge(R)],joinedDoc);
  const admitted=validateParagraphLineage(records,joinedDoc)!;
  expect(admitted.length).toBe(1_000_000);
  expect(admitted[0]).toEqual(records[0]);
  expect(admitted[999999]).toEqual(records[999999]);
},30000);
