import {act,fireEvent,render,waitFor} from "@testing-library/react";
import {expect,test,vi} from "vitest";
import {History} from "../src/history/History";
import {reply} from "./d06.fixtures";
import {deferred,mockApi} from "./helpers";
import {historyPath,versionPath,versionTextB} from "./historyFixtures";
import {chapterA,named,seriesId,historyNamed,errorReply} from "./namedCutFixtures";
import {body,undo,live,removed,restoration,removal,history,path,uuid} from "./snapshotLabelFixtures";
type Handler=Parameters<typeof mockApi>[0][number];
function mount(read:Handler["reply"]=reply(history()),post:Handler["reply"]=reply(removal)){
 const notify=vi.fn(()=>"kept" as const);
 const api=mockApi([{method:"GET",path:historyPath,reply:read},{method:"GET",path:versionPath(named.id),reply:reply(versionTextB)},{method:"POST",path,reply:post}]);
 const element=(token=0,key="old")=><History key={key} chapterId={chapterA.id} seriesId={seriesId} timeZone="UTC" onRestored={notify} refreshToken={token}/>;
 const ui=render(element());const p=(name:string)=>ui.container.querySelector<HTMLElement>('[data-part="'+name+'"]')!;
 const row=()=>ui.container.querySelector<HTMLElement>('[data-version-id="'+named.id+'"]')!;
 const ready=()=>waitFor(()=>expect(p("snapshot-filter")).toBeInTheDocument());
 const open=async()=>{await ready();fireEvent.click(row().querySelector('[data-part="version-open"]')!);await waitFor(()=>expect(p("snapshot-remove")).toBeInTheDocument());};
 return {...ui,...api,p,row,ready,open,notify,refresh:(token:number,key="old")=>ui.rerender(element(token,key))};
}
test("AXB-0109/0111 AC1: confirmed Remove and Undo in both filters preserve row and native focus",async()=>{
 for(const filter of ["named","all"]){
  const held=deferred<ReturnType<typeof reply>>();
  const ui=mount(reply(history()),(_,n)=>n===0?held.promise:reply(restoration));
  await ui.ready();fireEvent.click(ui.p("snapshot-"+filter));await ui.open();
  const remove=ui.p("snapshot-remove"),row=ui.row(),preview=ui.p("preview-line"),status=ui.p("snapshot-lifecycle-status");
  expect(remove.tagName).toBe("BUTTON");expect(remove).toHaveClass("ax-button--quiet","ax-history__snapshot-action");
  expect(remove.lastElementChild).toHaveClass("ax-history__snapshot-action-label");
  expect(remove.parentElement?.lastElementChild).toBe(remove);
  expect(status).toHaveAttribute("aria-live","polite");expect(status).toHaveAttribute("aria-atomic","true");
  remove.focus();fireEvent.click(remove);fireEvent.click(remove);
  expect(status).toHaveTextContent("Removing snapshot name…");expect(remove).toHaveAttribute("aria-disabled","true");
  expect(ui.p("version-restore")).toHaveAttribute("aria-disabled","true");expect(ui.row()).toBe(row);expect(ui.p("snapshot-name")).toBeInTheDocument();
  expect(ui.calls.filter(c=>c.method==="POST").map(c=>c.body)).toEqual([body]);
  await act(async()=>held.resolve(reply(removal)));
  expect(ui.p("snapshot-lifecycle-status")).toBe(status);expect(status).toHaveTextContent("Snapshot name removed. The saved version is still in History.");
  expect(ui.p("snapshot-remove-undo")).toHaveFocus();expect(ui.p("snapshot-name")).toBeNull();
  if(filter==="named"){expect(ui.row()).toBeNull();expect(ui.p("snapshot-empty")).toBeInTheDocument();}
  else{expect(ui.row()).toBe(row);expect(ui.p("preview-line")).toBe(preview);}
  fireEvent.click(ui.p("snapshot-remove-undo"));await waitFor(()=>expect(status).toHaveTextContent("Snapshot name restored."));
  expect(ui.p("snapshot-remove-undo")).toBeNull();expect(ui.row().querySelector('[data-part="version-open"]')).toHaveFocus();
  expect(ui.p("snapshot-name")).toHaveTextContent("Before the bell");expect(ui.calls.filter(c=>c.method==="POST").map(c=>c.body)).toEqual([body,undo]);expect(ui.notify).not.toHaveBeenCalled();
  ui.unmount();
 }
});
test("AXB-0109/0111 AC2: reject, checking, unconfirmed, check again, stale read",async()=>{
 const stale=deferred<ReturnType<typeof reply>>(),held=deferred<ReturnType<typeof reply>>(),check=deferred<ReturnType<typeof reply>>();
 const ui=mount((_,n)=>n===0?reply(history()):n===1?stale.promise:n===2?held.promise:check.promise,errorReply(500,"internal"));
 await ui.open();ui.refresh(1);const remove=ui.p("snapshot-remove");remove.focus();fireEvent.click(remove);
 await waitFor(()=>expect(ui.p("snapshot-lifecycle-status")).toHaveTextContent("Checking snapshot name…"));
 expect(ui.container.querySelector(".ax-history__snapshot-check-rule")).toHaveAttribute("aria-hidden","true");
 await act(async()=>held.resolve(reply(historyNamed)));
 expect(ui.p("snapshot-lifecycle-failure")).toHaveTextContent("The snapshot name change could not be confirmed.");
 expect(ui.p("snapshot-lifecycle-check")).toBeInTheDocument();expect(remove).toHaveFocus();
 expect(ui.container.querySelector(".ax-history__snapshot-check-rule")).toBeNull();
 ui.p("snapshot-lifecycle-check").focus();fireEvent.click(ui.p("snapshot-lifecycle-check"));
 await act(async()=>check.resolve(reply(history(removed))));
 expect(ui.p("snapshot-remove-undo")).toHaveFocus();expect(ui.p("snapshot-name")).toBeNull();
 await act(async()=>stale.resolve(reply(history())));
 expect(ui.p("snapshot-name")).toBeNull();expect(ui.calls.filter(c=>c.method==="POST")).toHaveLength(1);
 expect(ui.calls.filter(c=>c.path===historyPath)).toHaveLength(4);
});
test("AXB-0109 AC3: unchanged, changed, missing metadata and expired mount",async()=>{
 for(const [served,copy] of [[history(),"The snapshot name change could not be confirmed."],[history({...live,snapshot_id:uuid(99)}),"This snapshot name has changed."]] as const){
  const ui=mount((_,n)=>reply(n===0?history():served),reply(null));
  await ui.open();ui.p("snapshot-all").focus();fireEvent.click(ui.p("snapshot-remove"));
  await waitFor(()=>expect(ui.p("snapshot-lifecycle-failure")).toHaveTextContent(copy));
  expect(ui.p("snapshot-all")).toHaveFocus();expect(ui.p("snapshot-lifecycle-check")).toBeNull();expect(ui.p("snapshot-remove")).not.toHaveAttribute("aria-disabled");ui.unmount();
 }
 const held=deferred<ReturnType<typeof reply>>();const ui=mount(reply(history()),()=>held.promise);await ui.open();fireEvent.click(ui.p("snapshot-remove"));ui.refresh(0,"new");await ui.ready();await act(async()=>held.resolve(errorReply(500,"internal")));expect(ui.calls.filter(c=>c.path===historyPath)).toHaveLength(2);ui.unmount();
 const old=mount(reply(historyNamed));await old.ready();fireEvent.click(old.row().querySelector('[data-part="version-open"]')!);await waitFor(()=>expect(old.p("preview-line")).toBeInTheDocument());expect(old.p("snapshot-remove")).toBeNull();
});
