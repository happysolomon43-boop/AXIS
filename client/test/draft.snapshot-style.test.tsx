import {act,fireEvent,waitFor} from "@testing-library/react";
import {expect,test} from "vitest";
import type {CaptureRequest} from "../src/api/types";
import css from "../src/styles/draft-snapshot.css?raw";
import {mountDraft} from "./draftFixtures";
import {detailText,reply} from "./d06.fixtures";
import {capturePath,captureReply} from "./snapshotCaptureFixtures";
import {deferred} from "./helpers";
test("AXB-0104 AC1: stable native controls, labels, feedback and editor",async()=>{
 const pending=deferred<ReturnType<typeof reply>>();
 const ui=mountDraft({writes:[{method:"POST",path:capturePath,reply:()=>pending.promise}]});await ui.loaded();
 const trigger=ui.part("snapshot");expect(trigger).toHaveClass("ax-button","ax-button--quiet","ax-draft__snapshot");expect(trigger.nextElementSibling).toBe(ui.part("save"));
 const editor=ui.part("editor");fireEvent.click(trigger);const form=ui.part("snapshot-form"),name=ui.part("snapshot-name");
 expect(form).toHaveClass("ax-draft__snapshot-form");expect(ui.part("leaf")).not.toContainElement(form);
 expect(name).toHaveAccessibleName("Snapshot name (optional)");expect(name).toHaveAccessibleDescription("Leave blank to use the saved version’s default name.");
 expect(name).toHaveAttribute("dir","auto");expect(ui.part("snapshot-submit")).toHaveClass("ax-button--secondary");expect(ui.part("snapshot-cancel")).toHaveClass("ax-button--quiet");
 fireEvent.submit(form);expect(name).toHaveAttribute("readonly");expect(trigger).toHaveAttribute("aria-disabled","true");expect(trigger.querySelector("span")).toHaveTextContent("Snapshot");
 expect(ui.part("snapshot-status")).toHaveAttribute("aria-atomic","true");expect(ui.part("snapshot-status")).toHaveTextContent("Taking snapshot…");
 await act(async()=>pending.resolve(captureReply(ui.calls.find(c=>c.path===capturePath)!.body as CaptureRequest)));
 expect(ui.part("snapshot-status")).toHaveTextContent("Snapshot saved.");expect(ui.part("editor")).toBe(editor);expect(ui.root.querySelectorAll('[data-part="snapshot-status"]')).toHaveLength(1);
 ui.unmount();const absent=mountDraft({chapter:reply({...detailText,version:null})});await waitFor(()=>expect(absent.root).toHaveAttribute("data-state","failed"));expect(absent.part("snapshot")).toBeNull();
});
test("AXB-0104 AC2: invalid name has one ink marker and only its alert describes the input",async()=>{
 const ui=mountDraft({writes:[{method:"POST",path:capturePath,reply:reply({error:{code:"validation_failed",message:"invalid",details:{errors:[{path:"/name",message:"invalid"}]}}},400)}]});
 await ui.loaded();fireEvent.click(ui.part("snapshot"));fireEvent.submit(ui.part("snapshot-form"));
 await waitFor(()=>expect(ui.part("snapshot-failure")).toHaveTextContent("Use a valid name of at most 200 characters."));
 expect(ui.part("snapshot-name")).toHaveAttribute("aria-invalid","true");expect(ui.part("snapshot-name")).toHaveAccessibleDescription(/Use a valid name/);
 expect(ui.root.querySelectorAll(".ax-draft__snapshot-error-mark")).toHaveLength(1);expect(ui.root.querySelector(".ax-draft__snapshot-error-mark")).toHaveAttribute("aria-hidden","true");
 fireEvent.change(ui.part("snapshot-name"),{target:{value:"new"}});expect(ui.part("snapshot-failure")).toBeNull();
});
test("AXB-0104 AC3/AC4: local declarations, responsive targets and colour bindings",()=>{
 for(const rule of ["inline-size: min(100%, 20rem)","min-inline-size: 0","@media (max-width: 767px)","@media (pointer: coarse)","var(--ax-size-hit-touch)","outline-offset: 2px","@media (prefers-reduced-motion: reduce)","@media (forced-colors: active)","forced-color-adjust: auto","120ms","80ms","6%","14%"])expect(css).toContain(rule);
 for(const colour of ["#F8F8F6","#17181A","#EDE3CE","#FCFCFD","#0F1113","#F0E6D6","#FBF8F2","#1C1916","#E9DCC1"])expect(css).toContain(colour);
});
