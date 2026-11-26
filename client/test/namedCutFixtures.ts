import type { ChapterHistory, HistoryItem, NamedSnapshot } from "../src/api/types";
import { chapterA, histA, histB, histC, historyThree } from "./historyFixtures";
import { seriesA } from "./helpers";
export const seriesId=seriesA.id;
export const namePath="/api/series/"+seriesId+"/named-cuts";
export function snapshot(row:HistoryItem=histB,name="Before the bell"):NamedSnapshot {
  return {chapter_id:row.chapter_id,version_id:row.id,kind:"snapshot",name,l_seq:row.l_seq,pack_pins:{},created_at:"2026-11-16T23:30:00.000Z"};
}
export const eligible:HistoryItem={...histC,source:"draft_edit",snapshot:null,can_name_snapshot:true};
export const named:HistoryItem={...histB,snapshot:snapshot(),can_name_snapshot:false};
export const historyNamed:ChapterHistory={...historyThree,versions:[eligible,named,{...histA,can_name_snapshot:false,snapshot:null}]};
export const historyEligible:ChapterHistory={...historyNamed,versions:[eligible,{...histB,can_name_snapshot:true,snapshot:null},histA]};
export function namedHistory(row:HistoryItem=eligible,name="Before the bell"):ChapterHistory {
  return {...historyEligible,versions:historyEligible.versions.map(item=>item.id===row.id?{...item,snapshot:snapshot(row,name),can_name_snapshot:false}:item)};
}
export function errorReply(status:number,code:string,details:unknown=null){
  return {status,body:{error:{code,message:"Raw server text",details}}};
}
export {chapterA};
