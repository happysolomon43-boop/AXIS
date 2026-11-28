import type { Node, Schema } from "prosemirror-model";
import { Step, StepMap, StepResult } from "prosemirror-transform";
import type { EditorDocument, ParagraphLineageRecord } from "../api/types";

type RecordValue = ParagraphLineageRecord;
export type LineageMap = ReadonlyMap<string, RecordValue>;
export type LineageChange = {kind:RecordValue["kind"];key_id:string;before:RecordValue|null;after:RecordValue|null};
const own = (o:object,k:string) => Object.prototype.hasOwnProperty.call(o,k);
const exact = (v:unknown,keys:string[]):v is Record<string,unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k=>own(v,k));
const id = (v:unknown):v is string => typeof v === "string" &&
  ((v.length===14 && /^b_[0-9a-f]{12}$/.test(v)) ||
   (v.length===39 && /^dp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)));
const compare = (a:string,b:string) => a<b ? -1 : a>b ? 1 : 0;
const recordOrder = (a:RecordValue,b:RecordValue) =>
  compare(a.kind,b.kind)||compare(a.old_id,b.old_id)||compare(a.new_id,b.new_id);
const changeOrder = (a:LineageChange,b:LineageChange) => compare(a.kind,b.kind)||compare(a.key_id,b.key_id);
const validRecord = (v:unknown):v is RecordValue => exact(v,["kind","old_id","new_id"]) &&
  (v.kind==="split" || v.kind==="merge") && id(v.old_id) && id(v.new_id) && v.old_id!==v.new_id;

export function sameRecord(a:RecordValue|null,b:RecordValue|null):boolean {
  return a===b || (a!==null && b!==null && a.kind===b.kind && a.old_id===b.old_id && a.new_id===b.new_id);
}
export function sameLineage(a:readonly RecordValue[]|null,b:readonly RecordValue[]|null):boolean {
  const x=a??[], y=b??[];
  return x.length===y.length && x.every((r,i)=>sameRecord(r,y[i]!));
}
export function checkParagraphLineage(records:unknown,document:EditorDocument):records is RecordValue[] {
  if (!Array.isArray(records)||records.length===0||records.length>1_000_000) return false;
  const ids=new Set(document.flatMap(r=>r.paragraph_id===null?[]:[r.paragraph_id]));
  const splits=new Set<string>(),merges=new Set<string>();
  let previous:RecordValue|null=null;
  for(const record of records) {
    if(!validRecord(record)||(previous!==null&&recordOrder(previous,record)>=0)) return false;
    if(record.kind==="split"){
      if(splits.has(record.new_id))return false;
      splits.add(record.new_id);
    } else {
      if(merges.has(record.old_id)||ids.has(record.old_id))return false;
      merges.add(record.old_id);
    }
    if(!ids.has(record.new_id))return false;
    previous=record;
  }
  return true;
}

export const keyId = (r:RecordValue) => r.kind==="split" ? r.new_id : r.old_id;
export const lineageKey = (kind:RecordValue["kind"],key_id:string) => kind+":"+key_id;
const recordKey = (r:RecordValue) => lineageKey(r.kind,keyId(r));
export function lineageMap(records:readonly RecordValue[]):LineageMap {
  return new Map(records.map(r=>[recordKey(r),Object.freeze({...r})]));
}
export function canonicalLineage(map:LineageMap):RecordValue[] {
  return [...map.values()].sort(recordOrder).map(r=>({...r}));
}
export function paragraphIds(doc:Node):Set<string> {
  const ids=new Set<string>();
  doc.forEach(n=>{if(n.type.name==="paragraph")ids.add(n.attrs.block_uid);});
  return ids;
}

// Resolve each chain once, including failed walks and cycles.
export function normalizeLineage(map:LineageMap,live:ReadonlySet<string>):LineageMap {
  const result=new Map<string,RecordValue>();
  const targets=new Map<string,string>();
  for(const [key,r] of map) {
    if(r.kind==="split"){
      if(live.has(r.new_id))result.set(key,r);
    } else if(!live.has(r.old_id))targets.set(r.old_id,r.new_id);
  }
  const resolved=new Map<string,string|null>();
  function resolve(start:string):string|null {
    const path:string[]=[], seen=new Set<string>();
    let cursor=start, target:string|null=null;
    for(;;){
      if(live.has(cursor)){target=cursor;break;}
      if(resolved.has(cursor)){target=resolved.get(cursor)!;break;}
      if(seen.has(cursor))break;
      const next=targets.get(cursor);
      if(next===undefined)break;
      seen.add(cursor);path.push(cursor);cursor=next;
    }
    for(const old of path)resolved.set(old,target);
    return target;
  }
  for(const old_id of targets.keys()){
    const new_id=resolve(old_id);
    if(new_id!==null&&new_id!==old_id){
      const r:RecordValue={kind:"merge",old_id,new_id};
      result.set(recordKey(r),Object.freeze(r));
    }
  }
  return result;
}

export function reduceLineage(map:LineageMap,changes:readonly LineageChange[]):LineageMap {
  const next=new Map(map);
  for(const c of changes){
    const key=lineageKey(c.kind,c.key_id);
    if(!sameRecord(next.get(key)??null,c.before))continue;
    if(c.after===null)next.delete(key);
    else next.set(key,Object.freeze({...c.after}));
  }
  return next;
}
export function lineageChanges(before:LineageMap,after:LineageMap):LineageChange[] {
  const changes:LineageChange[]=[];
  for(const key of new Set([...before.keys(),...after.keys()])){
    const a=before.get(key)??null,b=after.get(key)??null;
    if(sameRecord(a,b))continue;
    const r=(a??b)!;
    changes.push({kind:r.kind,key_id:keyId(r),before:a,after:b});
  }
  return changes.sort(changeOrder);
}

function checkedChanges(value:unknown):LineageChange[] {
  if(!Array.isArray(value)||value.length===0)throw new RangeError("Invalid paragraph lineage step");
  const changes:LineageChange[]=[];
  for(const item of value){
    if(!exact(item,["kind","key_id","before","after"])||
       (item.kind!=="split"&&item.kind!=="merge")||!id(item.key_id))throw new RangeError("Invalid paragraph lineage step");
    const {kind,key_id,before,after}=item;
    const validSide=(r:unknown):r is RecordValue|null=>r===null||(validRecord(r)&&r.kind===kind&&keyId(r)===key_id);
    if(!validSide(before)||!validSide(after)||sameRecord(before,after))throw new RangeError("Invalid paragraph lineage step");
    const c:LineageChange={kind,key_id,before:before===null?null:Object.freeze({...before}),after:after===null?null:Object.freeze({...after})};
    if(changes.length&&changeOrder(changes[changes.length-1]!,c)>=0)throw new RangeError("Invalid paragraph lineage step");
    changes.push(Object.freeze(c));
  }
  return changes;
}
export class ParagraphLineageStep extends Step {
  readonly changes:readonly LineageChange[];
  constructor(changes:readonly LineageChange[]){
    super();
    this.changes=Object.freeze(checkedChanges(changes));
  }
  apply(doc:Node){return StepResult.ok(doc);}
  getMap(){return StepMap.empty;}
  invert(){return new ParagraphLineageStep(this.changes.map(c=>({...c,before:c.after,after:c.before})));}
  map(){return this;}
  merge(){return null;}
  toJSON(){return {stepType:"axisDraftParagraphLineage",changes:this.changes};}
  static fromJSON(_schema:Schema,json:unknown){
    if(!exact(json,["stepType","changes"])||json.stepType!=="axisDraftParagraphLineage")throw new RangeError("Invalid paragraph lineage step");
    return new ParagraphLineageStep(checkedChanges(json.changes));
  }
}
Step.jsonID("axisDraftParagraphLineage",ParagraphLineageStep);
