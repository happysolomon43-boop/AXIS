import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CaptureRequest } from "../src/api/types";
import { b,c,detailText,reply,verRow } from "./d06.fixtures";
import { advance, edit, fakeClock, mountDraft, putOk } from "./draftFixtures";
import { deferred } from "./helpers";
import { capturePath,captureReply,requestId } from "./snapshotCaptureFixtures";
const chord=()=>fireEvent.keyDown(window,{code:"KeyS",ctrlKey:true,cancelable:true});
const post=(ui:ReturnType<typeof mountDraft>)=>ui.calls.filter(call=>call.method==="POST");
const form=(ui:ReturnType<typeof mountDraft>)=>ui.part("snapshot-form");
const error=(status:number,code:string,details:object|null=null)=>reply({error:{code,message:"untrusted",details}},status);
afterEach(()=>vi.useRealTimers());
test("AXB-0102 AC1: native form, focus, frozen write and current application",async()=>{
  const pending=deferred<ReturnType<typeof reply>>();
  const ui=mountDraft({writes:[{method:"POST",path:capturePath,reply:()=>pending.promise}]});
  await ui.loaded(); const editor=ui.part("editor"); const count=ui.calls.length;
  fireEvent.click(ui.part("snapshot")); expect(ui.part("snapshot-name")).toHaveFocus();
  fireEvent.change(ui.part("snapshot-name"),{target:{value:" First "}});
  fireEvent.click(ui.part("snapshot-cancel")); expect(form(ui)).toBeNull(); expect(ui.part("snapshot")).toHaveFocus();
  fireEvent.click(ui.part("snapshot")); expect(ui.part("snapshot-name")).toHaveValue("");
  fireEvent.keyDown(ui.part("snapshot-name"),{key:"Escape"}); expect(form(ui)).toBeNull();
  expect(ui.calls).toHaveLength(count);
  edit(ui.view()); fireEvent.click(ui.part("snapshot")); fireEvent.change(ui.part("snapshot-name"),{target:{value:" First "}});
  fireEvent.submit(form(ui)!); expect(post(ui)).toHaveLength(1);
  const body=post(ui)[0].body as CaptureRequest;
  expect(body).toMatchObject({base_version:b,base_revision:0,name:" First ",content:detailText.version!.content+"!"});
  expect(ui.part("snapshot-status")).toHaveTextContent("Taking snapshot…"); expect(ui.part("snapshot-name")).toHaveAttribute("readonly");
  expect(editor).toHaveAttribute("contenteditable","false"); expect(ui.part("snapshot")).toHaveAttribute("aria-disabled","true");
  fireEvent.submit(form(ui)!); chord(); expect(post(ui)).toHaveLength(1);
  await act(async()=>pending.resolve(captureReply(body)));
  expect(ui.part("snapshot-status")).toHaveTextContent("Snapshot saved."); expect(ui.part("editor")).toBe(editor);
  expect(ui.root).toHaveAttribute("data-state","clean"); expect(ui.onWritten).toHaveBeenCalledTimes(1);
  expect(ui.part("snapshot")).toHaveFocus();
});
test("AXB-0102 AC2: raw saved bytes, reuse and autosave settlement",async()=>{
  const raw={...detailText,version:{...detailText.version!,content:"# Title\n\nOne\n\n---\n\nTwo\n"}};
  const ui=mountDraft({chapter:reply(raw),writes:[{method:"POST",path:capturePath,reply:call=>captureReply(call.body as CaptureRequest,false,true,verRow(b,2,null))}]});
  await ui.loaded(); chord(); await waitFor(()=>expect(ui.part("snapshot-status")).toHaveTextContent("Snapshot saved."));
  expect(post(ui)[0].body).toMatchObject({content:raw.version.content,base_version:b,base_revision:0}); expect(post(ui)[0].body).not.toHaveProperty("name");
  ui.unmount();
  const pending=deferred<ReturnType<typeof reply>>();
  const next=mountDraft({put:()=>pending.promise,writes:[{method:"POST",path:capturePath,reply:call=>captureReply(call.body as CaptureRequest)}]});
  await next.loaded(); fakeClock(); edit(next.view()); await advance(2000); chord(); expect(post(next)).toHaveLength(0);
  await act(async()=>pending.resolve(reply(putOk(1))));
  expect(post(next)[0].body).toMatchObject({base_version:b,base_revision:1,content:detailText.version!.content+"!"});
  expect(next.part("snapshot-status")).toHaveTextContent("Snapshot saved.");
});
test("AXB-0102 AC3: determinate failures do not read a receipt; unknown manual recovery uses same UUID",async()=>{
  for(const [status,code,details,message] of [
    [400,"validation_failed",{errors:[{path:"/name",message:"invalid"}]},"Use a valid name of at most 200 characters."],
    [400,"validation_failed",{errors:[{path:"/content",message:"nothing to capture"}]},"nothing to capture"],
    [409,"snapshot_conflict",{reason:"name_exists"},"This version already has a snapshot name."],
    [409,"snapshot_conflict",{reason:"released_book"},"This chapter is released. A snapshot needs its locked version."],
    [409,"snapshot_conflict",{reason:"scene_hints"},"These edits cannot be captured with the saved scene hints."],
    [409,"snapshot_conflict",{reason:"request_mismatch"},"The snapshot could not be taken."],
    [401,"auth_required",null,"The snapshot could not be taken."],
    [404,"not_found",null,"The snapshot could not be taken."],
    [413,"payload_too_large",null,"The snapshot could not be taken."],
    [415,"unsupported_media_type",null,"The snapshot could not be taken."]
  ] as const){
    const ui=mountDraft({writes:[{method:"POST",path:capturePath,reply:error(status,code,details)}]});
    await ui.loaded(); fireEvent.click(ui.part("snapshot")); fireEvent.change(ui.part("snapshot-name"),{target:{value:" Name "}}); fireEvent.submit(form(ui)!);
    await waitFor(()=>expect(ui.part("snapshot-failure")).toHaveTextContent(message));
    expect(ui.part("snapshot-name")).toHaveValue(" Name "); expect(ui.calls.filter(x=>x.path.startsWith(capturePath))).toHaveLength(1);
    if(status===400&&"errors" in details!&&details.errors[0].path==="/name"){expect(ui.part("snapshot-name")).toHaveAttribute("aria-invalid","true"); fireEvent.change(ui.part("snapshot-name"),{target:{value:"New"}});expect(ui.part("snapshot-failure")).toBeNull();}
    ui.unmount();
  }
  vi.spyOn(crypto,"randomUUID").mockReturnValue(requestId);
  const pending=deferred<ReturnType<typeof reply>>();
  const ui=mountDraft({writes:[
    {method:"POST",path:capturePath,reply:error(500,"internal")},
    {method:"GET",path:capturePath+"/"+requestId,reply:(_,n)=>n===0?reply({capture:null}):pending.promise}
  ]});
  await ui.loaded();fireEvent.click(ui.part("snapshot"));fireEvent.submit(form(ui)!);
  await waitFor(()=>expect(ui.part("snapshot-failure")).toHaveTextContent("The snapshot could not be confirmed."));
  expect(ui.part("snapshot-submit")).toBeNull(); expect(ui.part("snapshot-name")).toHaveAttribute("readonly");
  const check=ui.part("snapshot-check-again"); (check as HTMLElement).focus(); fireEvent.click(check);
  expect(check).toHaveAttribute("aria-disabled","true"); expect(ui.part("snapshot-return")).toHaveAttribute("aria-disabled","true");
  fireEvent.click(check); expect(ui.calls.filter(x=>x.path===capturePath+"/"+requestId)).toHaveLength(2);
  await act(async()=>pending.resolve(captureReply(post(ui)[0].body as CaptureRequest)));
  expect(ui.onWritten).toHaveBeenCalledTimes(1); expect(ui.part("snapshot")).toHaveFocus(); expect(post(ui)).toHaveLength(1);
});
test("AXB-0102 AC4: stale confirmation preserves editor; late unmount cannot notify",async()=>{
  const pending=deferred<ReturnType<typeof reply>>();
  const ui=mountDraft({writes:[{method:"POST",path:capturePath,reply:()=>pending.promise}]});
  await ui.loaded(); edit(ui.view());const editor=ui.part("editor");chord();
  await act(async()=>pending.resolve(captureReply(post(ui)[0].body as CaptureRequest,true,false)));
  expect(ui.part("snapshot-status")).toHaveTextContent("Snapshot saved.");expect(ui.part("snapshot-failure")).toHaveTextContent("The draft has changed. Your text is still here.");
  expect(ui.root).toHaveAttribute("data-state","conflict");expect(ui.part("editor")).toBe(editor);expect(ui.onWritten).toHaveBeenCalledTimes(1);ui.unmount();
  const late=deferred<ReturnType<typeof reply>>();const next=mountDraft({writes:[{method:"POST",path:capturePath,reply:()=>late.promise}]});await next.loaded();chord();next.unmount();
  await act(async()=>late.resolve(captureReply(post(next)[0].body as CaptureRequest)));expect(next.onWritten).not.toHaveBeenCalled();
});
