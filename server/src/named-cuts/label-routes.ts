import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { uuidPattern } from "./capture.js";
import { changeChapterSnapshotLabel, type SnapshotLabelAction } from "./label-lifecycle.js";
const uuid={type:"string",pattern:uuidPattern,minLength:36,maxLength:36};
export function registerSnapshotLabelRoutes(app:FastifyInstance,{pool}:Deps):void {
  app.post<{Params:{id:string;versionId:string};Body:SnapshotLabelAction}>("/chapters/:id(^[\\s\\S]{1,100}$)/versions/:versionId(^[\\s\\S]{1,100}$)/snapshot-label",{
    schema:{body:{type:"object",oneOf:[
      {type:"object",additionalProperties:false,required:["action","snapshot_id","expected_token"],properties:{action:{const:"remove"},snapshot_id:uuid,expected_token:uuid}},
      {type:"object",additionalProperties:false,required:["action","snapshot_id","expected_token","name"],properties:{action:{const:"undo"},snapshot_id:uuid,expected_token:uuid,name:{type:"string"}}}
    ]}}
  },async(request,reply)=>{
    const actor=requireUser(request);
    const result=await changeChapterSnapshotLabel(pool,actor,request.params.id,request.params.versionId,request.body);
    return reply.header("Cache-Control","no-store").code(200).send(result);
  });
}
