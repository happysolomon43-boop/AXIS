import { expect, test } from "vitest";
import type { BlockRow } from "../src/corpus/repo.js";
import { projectDraftBlockUids } from "../src/drafts/paragraph-identity.js";
const texts = ["North", "River.", "He nodded.", "He nodded.", "* * *", "Brook."];
const kinds = ["heading", "paragraph", "paragraph", "paragraph", "scene_break", "paragraph"] as const;
const stored: BlockRow[] = texts.map((text,i) => ({ ordinal:i+1, kind:kinds[i]!, text, block_uid:"b_"+String(i+1).padStart(12,"0"), hash:"0".repeat(64) }));
const equal = stored.map(({ordinal,kind,text}) => ({ordinal,kind,text}));
const raw = "# North\n\nRiver.\n\nHe nodded.\n\nHe nodded.\n\n* * *\n\nBrook.";
const changed = ["North","Brook.","He nodded.","River!","* * *","He nodded.","New."].map((text,i) => ({
  ordinal:i+1, kind: i===0 ? "heading" as const : i===4 ? "scene_break" as const : "paragraph" as const, text,
}));
test("AXB-0137 AC1/2 exact ordinal projection and conservative changed-text projection", () => {
  const before=structuredClone({stored,equal,changed});
  expect(projectDraftBlockUids(raw,raw,stored,equal)).toEqual(equal.map((b,i)=>({...b,block_uid:b.kind==="paragraph"?stored[i]!.block_uid:null})));
  expect(projectDraftBlockUids(raw,"changed",stored,changed).map(b=>b.block_uid)).toEqual([null,stored[5]!.block_uid,null,null,null,null,null]);
  expect(projectDraftBlockUids(raw,"changed",stored,[equal[2]!])[0]!.block_uid).toBeNull();
  expect({stored,equal,changed}).toEqual(before);
});
test("AXB-0137 AC3/4 segmentation corruption fails closed, deterministic unmatched and empty results", () => {
  const before=structuredClone({stored,equal});
  for (const rows of [equal.slice(1),[{...equal[0]!,ordinal:2},...equal.slice(1)],[{...equal[0]!,text:"mismatch"},...equal.slice(1)],[{...equal[0]!,kind:"paragraph" as const},...equal.slice(1)]]) {
    expect(()=>projectDraftBlockUids(raw,raw,stored,rows)).toThrowError(/^Inconsistent block segmentation$/);
  }
  for(let i=0;i<2;i++){
    expect(projectDraftBlockUids(raw,"",stored,[])).toEqual([]);
    expect(projectDraftBlockUids(raw,"new",stored,[{ordinal:1,kind:"paragraph",text:"new"}])).toEqual([{ordinal:1,kind:"paragraph",text:"new",block_uid:null}]);
  }
  expect({stored,equal}).toEqual(before);
});
