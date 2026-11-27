import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Binder } from "../src/binder/Binder";
import { Shell } from "../src/shell/Shell";
import type { ChapterSync } from "../src/api/types";
import css from "../src/styles/binder-sync.css?raw";
import draftSource from "../src/draft/Draft.tsx?raw";
import { b, chapterA, chapterPath, detailText, reply } from "./d06.fixtures";
import { draftNone, draftPath } from "./draftFixtures";
import { chaptersPath, deferred, mockApi } from "./helpers";
import { internalEnvelope } from "./historyFixtures";
import { pbList, pbTree, pullBackReplyB, chapterNotFoundEnvelope } from "./pullbackFixtures";
import { syncDraftOnly, syncInBook, syncEdited, syncRevisedSame, syncRevised, withSync } from "./syncDraftFixtures";
const STYLESHEETS = [
  "../src/binder/binder.css","../src/binder/open.css","../src/binder/sync-layout.css",
  "../src/draft/autosave.css","../src/draft/conflict.css","../src/draft/draft.css",
  "../src/editor/editor.css","../src/history/history.css","../src/history/restore.css","../src/history/snapshot-lifecycle.css","../src/history/snapshots.css",
  "../src/onboarding/onboarding.css","../src/shell/drawer.css","../src/shell/shell.css",
  "../src/styles/base.css","../src/styles/binder-sync.css",
  "../src/styles/binder-menu.css","../src/styles/binder-pullback-check.css","../src/styles/draft-snapshot.css","../src/styles/page.css","../src/styles/opening.css","../src/styles/tokens.css",
].sort();
const unauthorizedEnvelope={status:401,body:{error:{code:"auth_required",message:"Missing or invalid X-Axis-User header",details:null}}};
const A=chapterA.id, meta=draftPath+"?view=sync", pull=chapterPath+"/pull-back";
const list=(sync:ChapterSync)=>({chapters:pbList.chapters.map(row=>row.id===A?{...row,version_id:b,active_version_id:b,sync}:row)});
const postA={...pullBackReplyB,body:{chapter:chapterA,active_version_id:b}};
const part=(scope:ParentNode,name:string)=>scope.querySelector<HTMLElement>('[data-part="'+name+'"]')!;
const root=(scope:ParentNode,surface:string)=>scope.querySelector<HTMLElement>('[data-surface="'+surface+'"]')!;
const skip='[data-part="editor-host"]';
function drawing(element:Element,skip?:string):unknown[] {
  const excluded=new Set(["class","id","for","aria-labelledby","aria-describedby","aria-controls","aria-owns"]);
  return [element,...element.querySelectorAll("*")].filter(el=>!skip||!el.closest(skip)).map(el=>[
    el.tagName.toLowerCase(),[...el.classList].sort(),
    [...el.attributes].filter(a=>!excluded.has(a.name)).map(a=>[a.name,a.value]).sort((a,b)=>a[0].localeCompare(b[0])),
    [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join("").trim(),
  ]);
}
function luminance(hex:string){
  const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
  return 0.2126*r+0.7152*g+0.0722*b;
}
function contrast(a:string,b:string){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
type Response = {status:number;body:unknown}|"network";
async function shell(initial:ChapterSync,held?:ReturnType<typeof deferred<Response>>){
  const {calls}=mockApi([
    {method:"GET",path:chaptersPath,reply:(_,n)=>reply(list(n===0?initial:syncRevisedSame))},
    {method:"GET",path:chapterPath,reply:reply(detailText)},
    {method:"GET",path:draftPath,reply:withSync({status:200,body:draftNone},initial)},
    {method:"POST",path:pull,reply:postA},
    {method:"GET",path:meta,reply:()=>held!.promise},
  ]);
  const ui=render(<Shell tree={pbTree}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Open Chapter 1"}));
  await waitFor(()=>expect(root(ui.container,"draft")).toHaveAttribute("data-state","clean"));
  return {...ui,calls,draft:root(ui.container,"draft"),binder:root(ui.container,"binder")};
}
async function press(ui:Awaited<ReturnType<typeof shell>>){
  const button=within(ui.binder).getByRole("button",{name:"Pull back Chapter 1"});
  const row=button.parentElement!;
  button.focus();
  await act(async()=>{fireEvent.click(button);});
  expect(part(row,"chip")).toHaveTextContent("Being revised, no changes yet");
  return {row,focused:document.activeElement};
}
afterEach(()=>vi.unstubAllGlobals());
test("AXB-0089 AC1 hand-off draws exactly what an open draws",async()=>{
  for(const [sync,words] of [[syncDraftOnly,"Draft only"],[syncEdited,"In Book, edited since upload"],[syncRevisedSame,"Being revised, no changes yet"],[syncRevised,"Being revised"],[syncInBook,null]] as const){
    const held=deferred<Response>(), ui=await shell(sync===syncInBook?syncEdited:syncInBook,held);
    const before=drawing(ui.draft,skip), className=ui.draft.className, start=ui.calls.length;
    const {focused}=await press(ui);
    expect(drawing(ui.draft,skip)).toEqual(before);
    await act(async()=>{held.resolve(reply({sync}));});
    expect(ui.draft).toHaveAttribute("data-state","clean");expect(ui.draft.className).toBe(className);
    const chip=part(ui.draft,"version-chip");
    if(words===null)expect(chip).toBeNull();
    else{
      expect(chip).toHaveClass("ax-binder__sync");expect(chip.textContent).toBe(words);
      for(const attr of ["aria-live","role","style","data-state"])expect(chip).not.toHaveAttribute(attr);
    }
    expect(document.activeElement).toBe(focused);
    expect(part(ui.draft,"toolbar").querySelector("[style]")).toBeNull();
    expect(ui.calls.slice(start).map(c=>c.method+" "+c.path).sort()).toEqual(["POST "+pull,"GET "+chaptersPath,"GET "+meta,"GET "+chapterPath,"GET "+draftPath].sort());
    const drawn=drawing(ui.draft,skip);ui.unmount();
    const fresh=await shell(sync);expect(drawing(fresh.draft,skip)).toEqual(drawn);fresh.unmount();
  }
});
test("AXB-0089 AC2 failed refresh draws nothing",async()=>{
  for(const result of [internalEnvelope,chapterNotFoundEnvelope,unauthorizedEnvelope,"network",reply({})] as const){
    const held=deferred<Response>(),ui=await shell(syncInBook,held);
    const before=drawing(ui.draft,skip),autosave=ui.draft.getAttribute("data-autosave");
    const {row,focused}=await press(ui);
    await act(async()=>{held.resolve(result);});
    expect(drawing(ui.draft,skip)).toEqual(before);
    expect(ui.draft).toHaveAttribute("data-state","clean");expect(ui.draft).toHaveAttribute("data-autosave",autosave!);
    for(const name of ["conflict","reload-failure","reading","version-chip"])expect(part(ui.draft,name)).toBeNull();
    expect(part(ui.draft,"toolbar").querySelector("[style]")).toBeNull();expect(document.activeElement).toBe(focused);
    expect(part(row,"chip")).toHaveTextContent("Being revised, no changes yet");
    expect(part(ui.binder,"pull-back-failure")).toBeNull();ui.unmount();
  }
});
test("AXB-0089 AC3 Binder retains the D10 drawing and focus rule",async()=>{
  const post=deferred<Response>(),spy=vi.fn();
  mockApi([{method:"GET",path:chaptersPath,reply:(_,n)=>reply(list(n===0?syncInBook:syncRevisedSame))},{method:"POST",path:pull,reply:()=>post.promise}]);
  const ui=render(<Binder tree={pbTree} openChapterId={A} onChapterPullBackLanded={spy}/>);
  const button=await screen.findByRole("button",{name:"Pull back Chapter 1"}),row=button.parentElement!,binder=root(ui.container,"binder");
  button.focus();fireEvent.click(button);
  expect(button).toHaveTextContent("Pulling back...");expect(button).toHaveAttribute("aria-disabled","true");
  expect(button).toHaveClass("ax-button","ax-button--quiet","ax-binder__pullback");
  expect(binder.querySelector('[role="status"],[role="alert"]')).toBeNull();expect(spy).not.toHaveBeenCalled();
  await act(async()=>{post.resolve(postA);});
  expect(spy.mock.calls).toEqual([[A]]);
  expect(part(row,"chapter-pull-back")).toBeNull();expect(part(row,"chip")).toHaveClass("ax-binder__sync");
  expect(part(row,"chip")).toHaveTextContent("Being revised, no changes yet");
  expect(row.lastElementChild).toBe(part(row,"chapter-open"));
  expect(part(row,"chapter-open")).toHaveAttribute("aria-current","true");expect(part(row,"chapter-open")).toHaveFocus();
  const drawn=drawing(binder);ui.unmount();
  mockApi([{method:"GET",path:chaptersPath,reply:reply(list(syncRevisedSame))}]);
  const fresh=render(<Binder tree={pbTree} openChapterId={A}/>);
  await screen.findByRole("button",{name:"Open Chapter 1"});
  expect(drawing(root(fresh.container,"binder"))).toEqual(drawn);fresh.unmount();
  spy.mockClear();
  mockApi([{method:"GET",path:chaptersPath,reply:(_,n)=>reply(list(n===0?syncInBook:syncEdited))},{method:"POST",path:pull,reply:internalEnvelope}]);
  const failed=render(<Binder tree={pbTree} openChapterId={A} onChapterPullBackLanded={spy}/>);
  const failedButton=await screen.findByRole("button",{name:"Pull back Chapter 1"});
  failedButton.focus();await act(async()=>{fireEvent.click(failedButton);});
  const failure=part(failed.container,"pull-back-failure");
  expect(failure).toHaveClass("ax-binder__pullback-failure");expect(failure).toHaveTextContent("The chapter could not be pulled back.");
  expect(spy).not.toHaveBeenCalled();
  const failedDrawing=drawing(root(failed.container,"binder")).filter(entry=>(entry as unknown[])[3]!=="The chapter could not be pulled back.");
  failed.unmount();
  mockApi([{method:"GET",path:chaptersPath,reply:reply(list(syncEdited))}]);
  const baseline=render(<Binder tree={pbTree} openChapterId={A}/>);
  await screen.findByRole("button",{name:"Open Chapter 1"});
  expect(failedDrawing).toEqual(drawing(root(baseline.container,"binder")));baseline.unmount();
});
test("AXB-0089 AC4 stylesheet inventory, exact chip rule, import order, contrast",()=>{
  const declarations=css.match(/\.ax-binder__sync\s*\{([^}]+)\}/)![1].split(";").map(s=>s.trim()).filter(Boolean);
  expect(declarations).toEqual(["box-sizing: border-box","max-inline-size: 100%","block-size: auto","min-block-size: 20px","white-space: normal","overflow-wrap: anywhere","text-align: start","color: var(--ax-color-text-secondary)"]);
  const imports=[...draftSource.matchAll(/import\s+["']([^"']+\.css)["']/g)].map(m=>m[1]);
  expect(imports.slice(-2)).toEqual(["../styles/binder-sync.css","../styles/draft-snapshot.css"]);
  expect(Object.keys(import.meta.glob("../src/**/*.css")).sort()).toEqual(STYLESHEETS);
  for(const [ink,shellColor,raised,tint,floors] of [
    ["#4A4D52","#ECEBE6","#FCFCFA","#DCE7F2",[7,8,6]],
    ["#A9A79F","#0B0C0E","#0E1012","#1B2733",[8,7,6]],
    ["#4F4636","#D8CAAD","#F6EEDD","#C8D0D2",[5,8,5]],
  ] as const){
    const ratios=[shellColor,raised,tint].map(bg=>contrast(ink,bg));
    ratios.forEach(r=>expect(r).toBeGreaterThanOrEqual(4.5));expect(ratios.map(Math.floor)).toEqual(floors);
  }
});
