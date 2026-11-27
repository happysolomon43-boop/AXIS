import type { ChapterDetail, WorkingState, BlockRow, DraftDetail } from "../src/api/types";
import { detail, head } from "./d18Fixtures";
import { workingState } from "./writeFixtures";
export const raw="# North\n\nRiver.\n\nHe nodded.\n\nHe nodded.\n\n* * *\n\nBrook.";
export const changedRaw="# North\n\nBrook.\n\nHe nodded.\n\nRiver!\n\n* * *\n\nHe nodded.\n\nNew.";
export const uid=(n:number)=>"b_"+String(n).padStart(12,"0");
const blocks: BlockRow[]=["North","River.","He nodded.","He nodded.","* * *","Brook."].map((text,i)=>({
  ordinal:i+1,kind:i===0?"heading":i===4?"scene_break":"paragraph",text,block_uid:uid(i+1),hash:"0".repeat(64),
}));
export const saved:ChapterDetail={...detail,version:{...detail.version!,content:raw},blocks,scenes:[]};
const draft=(content:string,texts:string[]):DraftDetail=>({...head,draft:{...head.draft!,content,blocks:texts.map((text,i)=>({ordinal:i+1,kind:i===0?"heading":i===4?"scene_break":"paragraph",text}))}});
export const equal:WorkingState=workingState(saved,draft(raw,blocks.map(b=>b.text)));
export const changed:WorkingState=workingState(saved,draft(changedRaw,["North","Brook.","He nodded.","River!","* * *","He nodded.","New."]));
