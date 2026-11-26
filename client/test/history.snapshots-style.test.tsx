import { act,fireEvent,render,waitFor } from "@testing-library/react";
import { expect,test } from "vitest";
import { History } from "../src/history/History";
import css from "../src/history/snapshots.css?raw";
import drawer from "../src/shell/drawer.css?raw";
import tokens from "../src/styles/tokens.css?raw";
import { reply } from "./d06.fixtures";
import { deferred,mockApi } from "./helpers";
import { historyPath,versionPath,versionTextB } from "./historyFixtures";
import { chapterA,eligible,named,historyEligible,historyNamed,namePath,seriesId,snapshot,errorReply,namedHistory } from "./namedCutFixtures";

const part=(root:Element,name:string)=>root.querySelector<HTMLElement>('[data-part="'+name+'"]')!;
test("AXB-0097 AC1 filter, native buttons, source key and cut remain during preview and failure",async()=>{
  const preview=deferred<ReturnType<typeof reply>>();
  const {calls}=mockApi([{method:"GET",path:historyPath,reply:reply(historyNamed)},{method:"GET",path:versionPath(named.id),reply:()=>preview.promise}]);
  const ui=render(<History chapterId={chapterA.id} seriesId={seriesId} timeZone="UTC"/>);
  const p=(name:string)=>part(ui.container,name);
  await waitFor(()=>expect(p("snapshot-filter")).toBeInTheDocument());
  expect(p("snapshot-filter")).toHaveAttribute("aria-label","Snapshot filter");
  expect([...p("snapshot-filter").children].map(e=>e.textContent)).toEqual(["Named","All"]);
  expect(p("snapshot-all").tagName).toBe("BUTTON");expect(p("snapshot-all")).toHaveAttribute("aria-pressed","true");
  expect(p("snapshot-all").querySelector(".ax-history__snapshot-underline")).toHaveAttribute("aria-hidden","true");
  expect(p("snapshot-name-action")).toHaveClass("ax-button","ax-button--quiet","ax-history__snapshot-action");
  expect(p("snapshot-name")).toHaveClass("ax-history__snapshot-name");expect(p("snapshot-name").querySelector(".ax-history__snapshot-key")).toHaveTextContent("S");
  expect(p("snapshot-name").querySelector("bdi")).toHaveTextContent("Before the bell");expect(p("snapshot-name")).toHaveTextContent("named by you");
  fireEvent.click(p("snapshot-named"));expect(p("snapshot-named")).toHaveAttribute("aria-pressed","true");expect(calls).toHaveLength(1);
  fireEvent.click(p("version-open"));expect(p("version-reading")).toBeInTheDocument();expect(p("snapshot-cut")).toHaveTextContent("Version 2 · Ledger 2");
  expect(p("snapshot-capture").children).toHaveLength(3);
  await act(async()=>preview.resolve(reply(versionTextB)));expect(p("preview-line")).toBeInTheDocument();expect(p("snapshot-cut")).toHaveTextContent("Version 2 · Ledger 2");
  expect(p("version-date")).toHaveTextContent("22 Oct 2026 09:05");expect(p("version-source")).toHaveTextContent("Saved");expect(p("version-words")).toHaveTextContent("3 words");
});
test("AXB-0097 AC2 field associations, inert label spans, invalid marker and status",async()=>{
  const held=deferred<ReturnType<typeof reply>>();
  mockApi([{method:"GET",path:historyPath,reply:reply(historyEligible)},{method:"POST",path:namePath,reply:()=>held.promise}]);
  const ui=render(<History chapterId={chapterA.id} seriesId={seriesId}/>);
  const p=(name:string)=>part(ui.container,name);
  await waitFor(()=>expect(p("snapshot-name-action")).toBeInTheDocument());fireEvent.click(p("snapshot-name-action"));
  const field=p("snapshot-name-input");expect(field).toHaveClass("ax-input");expect(field).toHaveFocus();
  expect(ui.container.querySelector("label")).toHaveAttribute("for",field.id);
  expect(document.getElementById(field.getAttribute("aria-describedby")!)).toHaveTextContent("Leave blank to use the saved version’s default name.");
  fireEvent.change(field,{target:{value:"Invalid"}});fireEvent.submit(p("snapshot-name-form"));
  expect(p("snapshot-name-status")).toHaveAttribute("role","status");expect(p("snapshot-name-status")).toHaveTextContent("Naming snapshot…");
  expect(p("snapshot-name-submit")).toHaveClass("ax-button--secondary");expect(p("snapshot-name-submit")).toHaveAttribute("aria-disabled","true");
  expect(p("snapshot-name-submit").firstElementChild?.tagName).toBe("SPAN");expect(p("snapshot-name-submit")).toHaveTextContent("Name this version");
  expect(p("snapshot-name-cancel")).toHaveTextContent("Cancel");
  await act(async()=>held.resolve(errorReply(400,"validation_failed",{errors:[{path:"/name"}]})));
  expect(p("snapshot-name-failure")).toHaveAttribute("role","alert");expect(p("snapshot-name-failure").querySelector(".ax-glyph-square")).toHaveAttribute("aria-hidden","true");
  expect(field).toHaveAttribute("aria-invalid","true");expect(field.getAttribute("aria-describedby")).toContain(p("snapshot-name-failure").id);
  fireEvent.change(field,{target:{value:"Fixed"}});expect(p("snapshot-name-failure")).toBeNull();
});
function rgb(hex:string){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));}
function lum(rgb:number[]){return rgb.map(v=>{const x=v/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);}
function ratio(a:number[],b:number[]){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
test("AXB-0097 AC3 token-backed responsive, logical wrapping, targets and unchanged Drawer",()=>{
  for(const decl of ["grid-template-columns: repeat(2, minmax(0, 1fr))","overflow-wrap: anywhere","min-inline-size: 0","min-block-size: var(--ax-size-row)","min-inline-size: var(--ax-size-hit-touch)","min-block-size: var(--ax-size-hit-touch)","@media (pointer: coarse)","@media (max-width: 767px)","font-size: 1rem; line-height: 1.5rem","flex-wrap: wrap","font-family: var(--ax-type-family-chrome)"]) expect(css).toContain(decl);
  expect(drawer).toContain("@media (min-width: 1262px)");expect(drawer).toContain("block-size: 50dvh");expect(drawer).toContain("overflow-y: auto");
});
test("AXB-0097 AC4 all supplied themes and fills, selected cue, focus, reduced and forced colours",()=>{
  for(const [theme,room,ink,secondary,border,pencil,...pages] of [
    ["light","#ECEBE6","#1B1C1E","#4A4D52","#7E8186","#DCE7F2","#F8F8F6","#FCFCFD","#FBF8F2"],
    ["dark","#0B0C0E","#D9D6CD","#A9A79F","#72757A","#1B2733","#17181A","#0F1113","#1C1916"],
    ["sepia","#D8CAAD","#2B2418","#4F4636","#7A6D55","#C8D0D2","#EDE3CE","#F0E6D6","#E9DCC1"],
  ]){
    const block=tokens.split(':root[data-theme="'+theme+'"] {')[1].split("}")[0];
    for(const color of [room,ink,secondary,border,pencil])expect(block).toContain(color);
    const primary=rgb(ink);
    for(const fill of [room,pencil])for(const mix of [0,.06,.14]){
      const mixed=rgb(fill).map((v,i)=>v*(1-mix)+primary[i]*mix);
      expect(ratio(primary,mixed)).toBeGreaterThanOrEqual(7);
    }
    for(const bg of [room,pencil,...pages]){
      expect(ratio(rgb(border),rgb(bg))).toBeGreaterThanOrEqual(3);expect(ratio(primary,rgb(bg))).toBeGreaterThanOrEqual(7);
      expect(ratio(primary,rgb(bg))).toBeGreaterThanOrEqual(3);
    }
    expect(ratio(rgb(secondary),rgb(room))).toBeGreaterThanOrEqual(4.5);
    for(const page of pages)expect(css).toContain(page);
  }
  for(const declaration of ["outline: 2px solid var(--ax-color-focus)","outline-offset: 2px","box-shadow: 0 0 0 2px var(--ax-color-surface-shell)","opacity: 1","opacity: var(--ax-opacity-disabled)","border-block-end: 2px solid","var(--ax-dur-hover) var(--ax-ease-state) 0ms","transition-duration: var(--ax-dur-press)","@media (prefers-reduced-motion: reduce)","@media (forced-colors: active)","border-block-end-color: Highlight","outline-color: Highlight"])expect(css).toContain(declaration);
});
