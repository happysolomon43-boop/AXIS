import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mountDraft, fakeClock, advance } from "./draftFixtures";
import { deferred } from "./helpers";
import { capturePath, requestId, captureReply } from "./snapshotCaptureFixtures";
import type { CaptureRequest } from "../src/api/types";
import { reply } from "./d06.fixtures";
const reason=(el:HTMLElement)=>document.getElementById(el.getAttribute("aria-describedby")!);
test("AXB-0143 existing snapshot controls retain order and use scoped accessible reasons",async()=>{
 const pending=deferred<ReturnType<typeof reply>>();
 const ui=mountDraft({writes:[{method:"POST",path:capturePath,reply:()=>pending.promise}]});
 try{
  await ui.loaded();fakeClock();
  const original=ui.part("editor"),trigger=ui.part("snapshot");
  const order=Array.from(ui.part("toolbar").children).map(e=>e.getAttribute("data-part"));
  expect(order).toEqual(["version-chip","autosave","snapshot","save","send"]);
  expect(trigger).not.toHaveAttribute("aria-describedby");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-disabled","true");
  expect(reason(trigger)).toHaveTextContent("Finish or cancel the open snapshot form.");
  act(()=>trigger.focus());expect(reason(trigger)).toBeVisible();expect(trigger).toHaveFocus();
  fireEvent.keyDown(trigger,{key:"Escape"});expect(reason(trigger)).not.toBeVisible();
  fireEvent.submit(ui.part("snapshot-form"));
  expect(reason(trigger)).toHaveTextContent("Taking snapshot…");
  for(const part of ["snapshot-submit","snapshot-cancel"]){
   const button=ui.part(part);expect(button).toHaveAttribute("aria-disabled","true");
   act(()=>button.focus());expect(reason(button)).toBeVisible();expect(reason(button)).toHaveTextContent("Taking snapshot…");
  }
  expect(ui.part("editor")).toBe(original);
  expect(ui.calls.filter(c=>c.method==="POST")).toHaveLength(1);
  expect(document.querySelector("[data-block-uid]")).toBeNull();
  await advance(500);expect(ui.calls.filter(c=>c.method==="POST")).toHaveLength(1);
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
 expect(document.querySelector(".ax-tooltip")).toBeNull();
});

// jsdom has no native pointer hardware; use the actual scoped DOM listener with
// pointer identity and coordinates. The separate browser gate uses real input.
function pointer(el:EventTarget,type:string,pointerType:string,pointerId=1,clientX=0,clientY=0){
 const event=new MouseEvent(type,{bubbles:true,button:0,clientX,clientY});
 Object.defineProperties(event,{pointerType:{value:pointerType},pointerId:{value:pointerId}});
 act(()=>el.dispatchEvent(event));
}
test.each([["500ms","120ms"],[".5s",".12s"]])("AXB-0143 dwell %s and exit grace %s, cancel and long press are timer-clean",async(dwell,grace)=>{
 const ui=mountDraft();
 try{
  await ui.loaded();fakeClock();
  const trigger=ui.part("snapshot");
  trigger.style.setProperty("--ax-dwell-tooltip",dwell);trigger.style.setProperty("--ax-dur-hover",grace);
  fireEvent.click(trigger);
  const tip=reason(trigger)!;expect(tip).not.toBeVisible();
  pointer(trigger,"pointerenter","mouse");await advance(499);expect(tip).not.toBeVisible();
  await advance(1);expect(tip).toBeVisible();
  pointer(trigger,"pointerleave","mouse");await advance(119);expect(tip).toBeVisible();
  pointer(tip,"pointerenter","mouse");await advance(100);expect(tip).toBeVisible();
  pointer(tip,"pointerleave","mouse");await advance(120);expect(tip).not.toBeVisible();
  pointer(trigger,"pointerdown","touch",7);await advance(499);pointer(document,"pointerup","touch",7);await advance(1);
  act(()=>trigger.focus());expect(tip).not.toBeVisible();fireEvent.click(trigger);await advance(501);expect(tip).not.toBeVisible();
  act(()=>ui.part("snapshot-name").focus());
  pointer(trigger,"pointerdown","touch",8);pointer(document,"pointercancel","touch",8);await advance(500);expect(tip).not.toBeVisible();
  pointer(trigger,"pointerdown","touch",9);pointer(trigger,"pointerleave","touch",9);await advance(500);expect(tip).not.toBeVisible();
  pointer(trigger,"pointerdown","touch",10);await advance(500);expect(tip).toBeVisible();pointer(document,"pointerup","touch",10);
  await advance(120);expect(tip).toBeVisible();pointer(document.body,"pointerdown","touch",11);expect(tip).not.toBeVisible();
  act(()=>trigger.focus());expect(tip).toBeVisible();fireEvent.keyDown(trigger,{key:"Escape"});expect(tip).not.toBeVisible();await advance(1000);expect(tip).not.toBeVisible();
  act(()=>ui.part("snapshot-name").focus());fireEvent.keyDown(ui.part("snapshot-name"),{key:"Escape"});
  expect(ui.part("snapshot-form")).toBeNull();expect(trigger).not.toHaveAttribute("aria-describedby");expect(document.querySelector(".ax-tooltip")).toBeNull();expect(ui.calls).toHaveLength(1);
 }finally{ui.unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();}
});
test("AXB-0143 removed capture and manual readback keep original controls and only the exact receipt GET",async()=>{
 vi.spyOn(crypto,"randomUUID").mockReturnValue(requestId);
 const pending=deferred<ReturnType<typeof reply>>();
 const removed=reply({error:{code:"snapshot_conflict",message:"removed",details:{reason:"snapshot_removed"}}},409);
 const ui=mountDraft({writes:[{method:"POST",path:capturePath,reply:removed},
  {method:"GET",path:capturePath+"/"+requestId,reply:(_,n)=>n===0?removed:pending.promise}]});
 try{
  await ui.loaded();fireEvent.click(ui.part("snapshot"));fireEvent.submit(ui.part("snapshot-form"));
  await waitFor(()=>expect(ui.part("snapshot-failure")).toHaveTextContent("The snapshot could not be confirmed."));
  expect(ui.part("snapshot-submit")).toBeNull();expect(ui.part("snapshot-cancel")).toBeNull();
  expect(reason(ui.part("snapshot"))).toHaveTextContent("The snapshot could not be confirmed. Check again or return to Draft.");
  const check=ui.part("snapshot-check-again");expect(check).not.toHaveAttribute("aria-describedby");
  act(()=>check.focus());fireEvent.click(check);expect(reason(check)).toHaveTextContent("Checking snapshot…");
  expect(reason(ui.part("snapshot-return"))).toHaveTextContent("Checking snapshot…");
  expect(reason(check)).toBeVisible();expect(check).toHaveFocus();
  fireEvent.click(check);fireEvent.click(ui.part("snapshot-return"));
  expect(ui.calls.filter(c=>c.path.startsWith(capturePath)).map(c=>c.method)).toEqual(["POST","GET","GET"]);
  await act(async()=>pending.resolve(removed));
  expect(check).not.toHaveAttribute("aria-describedby");expect(ui.part("snapshot-return")).not.toHaveAttribute("aria-describedby");
  fireEvent.click(ui.part("snapshot-return"));expect(ui.root).toHaveAttribute("data-state","conflict");
  expect(ui.onWritten).not.toHaveBeenCalled();expect(ui.calls.filter(c=>c.method==="POST")).toHaveLength(1);expect(document.querySelector(".ax-tooltip")).toBeNull();
 }finally{ui.unmount();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
