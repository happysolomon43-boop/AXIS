import { act, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mountDraft, fakeClock, advance } from "./draftFixtures";
import { deferred } from "./helpers";
import { capturePath } from "./snapshotCaptureFixtures";
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
