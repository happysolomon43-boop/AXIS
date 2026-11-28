import { Fragment, type Node } from "prosemirror-model";
import { Plugin, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceStep } from "prosemirror-transform";
import type { ParagraphLineageRecord } from "../api/types";
import { ParagraphLineageStep, canonicalLineage, lineageChanges, lineageKey, lineageMap, normalizeLineage, paragraphIds, reduceLineage, type LineageMap } from "./paragraphLineage";
import { canonicalParagraphUid } from "./model";

export type DraftIdentityOptions = { mode: "draft"; allocateUuid: () => string; restoredParagraphIds: readonly (string | null)[]; restoredLineage?:readonly ParagraphLineageRecord[]; isHistoryReplay?:(tr:Transaction)=>boolean };
export class ParagraphAllocationError extends Error {}

function uuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

const normalizeMeta="axisDraftParagraphLineageNormalize";
const repairMeta="axisDraftParagraphIdentityRepair";
type Event =
  | {kind:"split"; first:number; second:number; transaction:number; step:number}
  | {kind:"merge"; first:number; absorbed:string; transaction:number; step:number};

// The structural slice and the actual adjacent top-level nodes must agree.
// Text equality, ordinary replace, node deletion and clipboard operations are not evidence.
function structuralEvents(transactions:readonly Transaction[]):Event[] {
  const events:Event[]=[];
  transactions.forEach((tr,transaction)=>tr.steps.forEach((step,i)=>{
    if(!(step instanceof ReplaceStep)||step.toJSON().structure!==true)return;
    const before=tr.docs[i]!, after=tr.docs[i+1]??tr.doc;
    if(step.from===step.to && step.slice.openStart===1 && step.slice.openEnd===1 &&
       step.slice.content.childCount===2 &&
       step.slice.content.firstChild?.type.name==="paragraph" && step.slice.content.firstChild.content.size===0 &&
       step.slice.content.lastChild?.type.name==="paragraph" && step.slice.content.lastChild.content.size===0 &&
       after.childCount===before.childCount+1){
      const at=before.resolve(step.from);
      if(at.depth!==1||at.parent.type.name!=="paragraph")return;
      const first=at.before(1),second=step.from+1;
      const a=after.nodeAt(first),b=after.nodeAt(second);
      if(a?.type.name==="paragraph"&&b?.type.name==="paragraph"&&first+a.nodeSize===second&&
        a.nodeSize+b.nodeSize===at.parent.nodeSize+2){
        events.push({kind:"split",first,second,transaction,step:i});
      }
    }else if(step.to===step.from+2&&step.slice.content.size===0&&step.slice.openStart===0&&step.slice.openEnd===0&&after.childCount===before.childCount-1){
      const boundary=before.resolve(step.from+1);
      if(boundary.depth!==0||boundary.nodeBefore?.type.name!=="paragraph"||boundary.nodeAfter?.type.name!=="paragraph")return;
      const first=boundary.pos-boundary.nodeBefore.nodeSize;
      const joined=after.nodeAt(first);
      if(joined?.type.name==="paragraph"&&joined.nodeSize===boundary.nodeBefore.nodeSize+boundary.nodeAfter.nodeSize-2){
        events.push({kind:"merge",first,absorbed:boundary.nodeAfter.attrs.block_uid,transaction,step:i});
      }
    }
  }));
  return events;
}
function mapStart(pos:number,event:Event,transactions:readonly Transaction[],repair:Transaction):number {
  for(let t=event.transaction;t<transactions.length;t++){
    const mapping=transactions[t]!.mapping;
    pos=(t===event.transaction?mapping.slice(event.step+1):mapping).map(pos,1);
  }
  return repair.mapping.map(pos,1);
}

export function createParagraphIdentity(options?: DraftIdentityOptions): { initialize(doc: Node): Node; plugin: Plugin<LineageMap>; lineage(state:EditorState):ParagraphLineageRecord[] } {
  const stored = new Set<string>(), issued = new Set<string>();
  const restoredIds = new Set(options?.restoredParagraphIds ?? []);
  const reservedIds = new Set((options?.restoredLineage??[]).flatMap(r=>[r.old_id,r.new_id]));
  let counter = 0, initialized = false;
  function allocate(count: number, admit=true): string[] {
    if (options) {
      const fresh = new Set<string>();
      for (let i=0; i<count; i++) {
        let value: unknown;
        try { value = options.allocateUuid(); } catch { throw new ParagraphAllocationError(); }
        if (!uuid(value)) throw new ParagraphAllocationError();
        const uid = "dp_" + value;
        if (stored.has(uid) || issued.has(uid) || fresh.has(uid) || restoredIds.has(uid) || reservedIds.has(uid)) throw new ParagraphAllocationError();
        fresh.add(uid);
      }
      if(admit)for (const uid of fresh) issued.add(uid);
      return [...fresh];
    }
    if (count > Number.MAX_SAFE_INTEGER - counter) throw new Error("Paragraph identity exhausted");
    return Array.from({ length: count }, () => {
      const uid = "local_p_" + (++counter);
      issued.add(uid);
      return uid;
    });
  }
  function initialize(doc: Node): Node {
    if (initialized) throw new Error("Paragraph identity already initialized");
    initialized = true;
    const children: Node[] = [];
    doc.forEach((node, _offset, index) => {
      if (node.type.name !== "paragraph") { children.push(node); return; }
      const uid = node.attrs.block_uid;
      const restored = options?.restoredParagraphIds[index];
      const admissible = canonicalParagraphUid(uid) && (!options?.restoredParagraphIds.length || restored === uid) ||
        (!!options && typeof uid === "string" && uid.startsWith("dp_") && uuid(uid.slice(3)) && restored === uid);
      if (admissible && !stored.has(uid)) { stored.add(uid); children.push(node); }
      else children.push(node.type.create({ ...node.attrs, block_uid: allocate(1)[0] }, node.content, node.marks));
    });
    return doc.copy(Fragment.fromArray(children));
  }
  const plugin = new Plugin<LineageMap>({
    state:{
      init:()=>lineageMap(options?.restoredLineage??[]),
      apply(tr,value){
        if(!options)return value;
        let next=value;
        for(const step of tr.steps)if(step instanceof ParagraphLineageStep)next=reduceLineage(next,step.changes);
        const normalized=tr.getMeta(normalizeMeta) as readonly ParagraphLineageRecord[]|undefined;
        return normalized===undefined?next:lineageMap(normalized);
      },
    },
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some(t => t.docChanged && !t.getMeta(repairMeta))) return null;
      const origin=transactions[0]!;
      const replay=options?.isHistoryReplay?.(origin)??false;
      const candidates = new Map<string, number[]>(), repair = new Set<number>(), oldStarts = new Map<string, number>();
      oldState.doc.forEach((node, pos) => {
        if (node.type.name === "paragraph") oldStarts.set(node.attrs.block_uid, pos);
      });
      newState.doc.forEach((node, pos) => {
        if (node.type.name !== "paragraph") return;
        const uid = node.attrs.block_uid;
        if (!stored.has(uid) && !issued.has(uid)) { repair.add(pos); return; }
        const positions = candidates.get(uid);
        if (positions) positions.push(pos); else candidates.set(uid, [pos]);
      });
      for (const [uid, positions] of candidates) {
        if (positions.length < 2) continue;
        let mapped = oldStarts.get(uid);
        if (mapped !== undefined) for (const t of transactions) mapped = t.mapping.map(mapped, 1);
        const keep = mapped !== undefined && positions.includes(mapped) ? mapped : positions[0];
        for (const pos of positions) if (pos !== keep) repair.add(pos);
      }
      if (repair.size === 0 && !options) return null;
      const ids = allocate(repair.size, !options), tr = newState.tr;
      let i = 0;
      newState.doc.forEach((node, pos) => {
        if (repair.has(pos)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, block_uid: ids[i++] });
      });
      // Markup replacements must not move the native operation's final selection.
      if(repair.size)tr.setSelection(newState.selection.getBookmark().resolve(tr.doc));
      if(options){
        const current=plugin.getState(newState)!;
        const live=paragraphIds(tr.doc);
        const working=new Map(current);
        if(!replay){
          const fresh=new Set(ids);
          const starts=new Map<number,string>();
          tr.doc.forEach((node,pos)=>{if(node.type.name==="paragraph")starts.set(pos,node.attrs.block_uid);});
          for(const event of structuralEvents(transactions)){
            const first=starts.get(mapStart(event.first,event,transactions,tr));
            if(first===undefined)continue;
            if(event.kind==="split"){
              const second=starts.get(mapStart(event.second,event,transactions,tr));
              if(second!==undefined&&first!==second&&fresh.has(second)){
                working.set(lineageKey("split",second),{kind:"split",old_id:first,new_id:second});
              }
            }else if(typeof event.absorbed==="string"&&event.absorbed!==first&&!live.has(event.absorbed)){
              working.set(lineageKey("merge",event.absorbed),{kind:"merge",old_id:event.absorbed,new_id:first});
            }
          }
        }
        const normalized=normalizeLineage(working,live);
        if(normalized.size>1_000_000)throw new ParagraphAllocationError();
        const changes=lineageChanges(current,normalized);
        if(changes.length){
          if(replay)tr.setMeta(normalizeMeta,canonicalLineage(normalized));
          else tr.step(new ParagraphLineageStep(changes));
        }
        for(const uid of ids)issued.add(uid);
        if(!tr.steps.length&&!changes.length)return null;
        if((replay&&!repair.size)||origin.getMeta("addToHistory")===false)tr.setMeta("addToHistory",false);
      }
      tr.setMeta(repairMeta,true);
      return tr;
    },
  });
  return { initialize, plugin, lineage:state=>options?canonicalLineage(plugin.getState(state)!):[] };
}
