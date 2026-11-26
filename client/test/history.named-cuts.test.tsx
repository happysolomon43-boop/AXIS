import { act,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { expect,test } from "vitest";
import { History } from "../src/history/History";
import { Shell } from "../src/shell/Shell";
import { chapterList,chapterPath,detailText,fourRows,reply } from "./d06.fixtures";
import { draftNone,draftPath } from "./draftFixtures";
import { histB,historyPath,versionPath,versionTextB } from "./historyFixtures";
import { deferred,mockApi,chaptersPath,treeA } from "./helpers";
import { chapterA,eligible,named,historyEligible,historyNamed,namePath,namedHistory,seriesId,snapshot,errorReply } from "./namedCutFixtures";
type Handler=Parameters<typeof mockApi>[0][number];
const part=(root:Element,name:string)=>root.querySelector<HTMLElement>('[data-part="'+name+'"]')!;
function mount(history:Handler["reply"],extra:Handler[]=[],withSeries=true){
  const api=mockApi([{method:"GET",path:historyPath,reply:history},...extra]);
  const component=(token=0,key="old")=><History key={key} chapterId={chapterA.id} seriesId={withSeries?seriesId:undefined} refreshToken={token} timeZone="UTC"/>;
  const ui=render(component());
  const p=(name:string)=>part(ui.container,name);
  return {...ui,...api,p,ready:()=>waitFor(()=>expect(p("snapshot-all")).toBeInTheDocument()),update:(token:number,key="old")=>ui.rerender(component(token,key)),
    rows:()=>[...ui.container.querySelectorAll<HTMLElement>('[data-part="version"]')],open:()=>fireEvent.click(p("snapshot-name-action")),
    edit:(value:string)=>fireEvent.change(p("snapshot-name-input"),{target:{value}}),
    submit:()=>fireEvent.submit(p("snapshot-name-form"))};
}
test("AXB-0095 AC1 filtering preserves order, served detail, preview and eligibility",async()=>{
  const ui=mount(reply(historyNamed),[{method:"GET",path:versionPath(named.id),reply:reply(versionTextB)}]);
  await ui.ready();expect(ui.rows().map(r=>r.dataset.versionId)).toEqual(historyNamed.versions.map(v=>v.id));
  expect(ui.container.querySelectorAll('[data-part="snapshot-name-action"]')).toHaveLength(1);
  fireEvent.click(ui.p("snapshot-named"));
  expect(ui.rows().map(r=>r.dataset.versionId)).toEqual([named.id]);
  expect(ui.p("snapshot-name")).toHaveTextContent("Before the bell");
  expect(ui.p("version-date")).toHaveTextContent("22 Oct 2026 09:05");
  expect(ui.p("version-source")).toHaveTextContent("Saved");expect(ui.p("version-words")).toHaveTextContent("3 words");
  fireEvent.click(ui.p("version-open"));await waitFor(()=>expect(ui.p("preview-line")).toBeInTheDocument());
  expect(ui.p("snapshot-cut")).toHaveTextContent("Version 2 · Ledger 2");
  expect(ui.p("snapshot-capture")).toHaveTextContent("Captured: saved chapter text and scene hints.");
  expect(ui.p("snapshot-capture")).toHaveTextContent("Reading coverage unavailable.");
  expect(ui.p("snapshot-capture")).toHaveTextContent("Not captured: workspace annotations, later rulings and attachments.");
  expect(ui.p("version-restore")).toBeInTheDocument(); // Newest original row, not newest filtered row, governs Restore.
  fireEvent.click(ui.p("snapshot-all"));expect(ui.p("in-book")).toBeInTheDocument();
  expect(ui.p("preview-line")).toBeInTheDocument();
  fireEvent.click(ui.p("snapshot-named"));expect(ui.p("preview-line")).toBeInTheDocument();
  expect(ui.calls.map(c=>c.path)).toEqual([historyPath,versionPath(named.id)]);ui.unmount();
  const empty=mount(reply(historyEligible));await empty.ready();fireEvent.click(empty.p("snapshot-named"));
  expect(empty.p("snapshot-empty")).toHaveTextContent("No snapshots yet.");expect(empty.p("snapshot-name-action")).toHaveAttribute("aria-label","Name this version, version 3");
  expect(empty.calls).toHaveLength(1);empty.unmount();
  const noSeries=mount(reply(historyNamed),[],false);await noSeries.ready();expect(noSeries.p("snapshot-name-action")).toBeNull();
  fireEvent.click(noSeries.p("snapshot-named"));expect(noSeries.p("snapshot-name")).toHaveTextContent("Before the bell");noSeries.unmount();
  const missing=mount(reply({...historyEligible,versions:historyEligible.versions.map(({snapshot:_,can_name_snapshot:__,...row})=>row)}));await missing.ready();expect(missing.p("snapshot-name-action")).toBeNull();
});
test("AXB-0095 AC2 Shell preserves editor, pending guard, focus, and served default after reopen",async()=>{
  const held=deferred<ReturnType<typeof reply>>();
  const {calls}=mockApi([
    {method:"GET",path:chaptersPath,reply:chapterList(fourRows.slice(0,1))},
    {method:"GET",path:chapterPath,reply:reply(detailText)},{method:"GET",path:draftPath,reply:reply(draftNone)},
    {method:"GET",path:historyPath,reply:(_,n)=>reply(n===0?historyEligible:namedHistory(eligible,"Default from server"))},
    {method:"POST",path:namePath,reply:()=>held.promise}
  ]);
  const ui=render(<Shell tree={treeA}/>);const p=(name:string)=>part(ui.container,name);
  fireEvent.click(await screen.findByRole("button",{name:"Open Chapter 1: Title"}));
  await waitFor(()=>expect(p("editor")).toBeInTheDocument());const editor=p("editor");
  fireEvent.click(p("history-door"));await waitFor(()=>expect(p("snapshot-name-action")).toBeInTheDocument());
  const opener=p("snapshot-name-action");opener.focus();fireEvent.click(opener);
  expect(p("snapshot-name-input")).toHaveFocus();expect(p("snapshot-name-form")).toHaveTextContent("Version 3");
  fireEvent.click(p("snapshot-name-cancel"));expect(opener).toHaveFocus();
  fireEvent.click(opener);fireEvent.change(p("snapshot-name-input"),{target:{value:"Before the bell"}});
  fireEvent.submit(p("snapshot-name-form"));fireEvent.submit(p("snapshot-name-form"));fireEvent.click(p("snapshot-name-cancel"));
  expect(p("snapshot-name-input")).toHaveAttribute("readonly");expect(p("snapshot-name-status")).toHaveTextContent("Naming snapshot…");
  expect(p("snapshot-name-submit")).toHaveAttribute("aria-disabled","true");
  fireEvent.click(p("snapshot-named"));expect(p("snapshot-name-form")).toBeInTheDocument();
  expect(calls.filter(c=>c.method==="POST")).toHaveLength(1);
  expect(calls.filter(c=>c.method==="POST")[0].body).toEqual({kind:"snapshot",chapter_id:chapterA.id,version_id:eligible.id,name:"Before the bell"});
  await act(async()=>held.resolve(reply({snapshot:snapshot(eligible,"Before the bell")},201)));
  expect(p("snapshot-name")).toHaveTextContent("Before the bell");expect(p("snapshot-name-status")).toHaveTextContent("Snapshot named.");
  expect(p("editor")).toBe(editor);expect(calls.filter(c=>c.path===historyPath)).toHaveLength(1);
  expect(calls.filter(c=>c.method!=="GET")).toHaveLength(1);
  fireEvent.click(p("drawer-close"));fireEvent.click(p("history-door"));await waitFor(()=>expect(p("snapshot-name")).toHaveTextContent("Default from server"));
});
test("AXB-0095 AC2 empty input omits name and focuses target row on successful default",async()=>{
  const ui=mount(reply(historyEligible),[{method:"POST",path:namePath,reply:reply({snapshot:snapshot(eligible,"Default name")},200)}]);
  await ui.ready();ui.open();ui.submit();await waitFor(()=>expect(ui.p("snapshot-name-status")).toHaveTextContent("Snapshot named."));
  expect(ui.calls[1].body).toEqual({kind:"snapshot",chapter_id:chapterA.id,version_id:eligible.id});
  expect(ui.p("snapshot-name")).toHaveTextContent("Default name");expect(ui.p("version-open")).toHaveFocus();
});
test("AXB-0095 AC3 lost reply settles once and preserves attempted text read-only",async()=>{
  const held=deferred<ReturnType<typeof reply>>(), settled=deferred<ReturnType<typeof reply>>();
  const ui=mount((_,n)=>n===0?reply(historyEligible):settled.promise,[{method:"POST",path:namePath,reply:()=>held.promise}]);
  await ui.ready();ui.open();ui.edit("Attempted name");ui.p("snapshot-name-submit").focus();ui.submit();
  await act(async()=>held.resolve(errorReply(500,"internal")));expect(ui.p("snapshot-name-status")).toHaveTextContent("Naming snapshot…");
  await act(async()=>settled.resolve(reply(namedHistory(eligible,"Authoritative name"))));
  expect(ui.p("snapshot-name-form")).toHaveTextContent("Authoritative name");expect(ui.p("snapshot-name-input")).toHaveValue("Attempted name");
  expect(ui.p("snapshot-name-input")).toHaveAttribute("readonly");expect(ui.p("snapshot-name-submit")).toBeNull();
  expect(ui.p("snapshot-name-status")).toHaveTextContent("This version is named.");expect(ui.p("snapshot-name-cancel")).toHaveFocus();
  expect(ui.calls.map(c=>c.method)).toEqual(["GET","POST","GET"]);
});
test("AXB-0095 AC3 fallback alert families, mismatched cut, explicit retry and focus",async()=>{
  const cases=[
    [errorReply(400,"validation_failed",{errors:[{path:"/name",message:"bad"}]}),"Use a valid name of at most 200 characters.",true,false],
    [errorReply(400,"validation_failed",{errors:[{path:"/version_id",message:"nothing to capture"}]}),"nothing to capture",false,false],
    [errorReply(409,"snapshot_conflict",{reason:"name_exists"}),"This version already has a name. Its name could not be refreshed.",false,true],
    [errorReply(409,"snapshot_conflict",{reason:"released_book"}),"This chapter is released. A snapshot needs its locked version.",false,true],
    ...[400,401,404,413,415,500].map(status=>[errorReply(status,"unknown"),"The snapshot could not be named.",false,false] as const),
    ["network","The snapshot could not be named.",false,false],
    [reply(null,201),"The snapshot could not be named.",false,false],
    [reply({snapshot:{...snapshot(eligible),l_seq:999}},201),"The snapshot could not be named.",false,false]
  ] as const;
  for(const [response,message,invalid,blocked] of cases){
    const ui=mount((_,n)=>n===0?reply(historyEligible):errorReply(500,"internal"),[{method:"POST",path:namePath,reply:response}]);
    await ui.ready();ui.open();ui.edit("Keep this");ui.submit();
    await waitFor(()=>expect(ui.p("snapshot-name-failure")).toHaveTextContent(message));
    expect(ui.p("snapshot-name-input")).toHaveValue("Keep this");expect(ui.p("snapshot-name-input")).not.toHaveAttribute("readonly");
    expect(ui.p("snapshot-name-input")).toHaveFocus();expect(ui.p("snapshot-name-input").hasAttribute("aria-invalid")).toBe(invalid);
    expect(!!ui.p("snapshot-name-submit")).toBe(!blocked);
    expect(ui.calls.map(c=>c.method)).toEqual(["GET","POST","GET"]);
    if(invalid){ui.edit("Changed");expect(ui.p("snapshot-name-failure")).toBeNull();expect(ui.p("snapshot-name-input")).not.toHaveAttribute("aria-invalid");}
    ui.unmount();
  }
});
test("AXB-0095 AC4 stale ordinary read cannot erase a confirmed snapshot; unmount ignores replies",async()=>{
  const stale=deferred<ReturnType<typeof reply>>(), held=deferred<ReturnType<typeof reply>>();
  const ui=mount((_,n)=>n===0?reply(historyEligible):stale.promise,[{method:"POST",path:namePath,reply:()=>held.promise}]);
  await ui.ready();ui.update(1);ui.open();ui.submit();ui.p("snapshot-all").focus();
  await act(async()=>held.resolve(reply({snapshot:snapshot(eligible)},201)));
  expect(ui.p("snapshot-all")).toHaveFocus();
  await act(async()=>stale.resolve(reply({...historyEligible,versions:historyEligible.versions.map(row=>({...row,word_count:7}))})));
  expect(ui.p("snapshot-name")).toHaveTextContent("Before the bell");expect(ui.p("version-words")).toHaveTextContent("7 words");
  expect(ui.rows()[0].querySelector('[data-part="snapshot-name-action"]')).toBeNull();ui.unmount();
  const later=deferred<ReturnType<typeof reply>>();
  const next=mount(reply(historyEligible),[{method:"POST",path:namePath,reply:()=>later.promise}]);
  await next.ready();next.open();next.submit();next.update(0,"new");await next.ready();
  await act(async()=>later.resolve(errorReply(500,"internal")));
  expect(next.p("snapshot-name-form")).toBeNull();expect(next.calls.map(c=>c.method)).toEqual(["GET","POST","GET"]);
});
