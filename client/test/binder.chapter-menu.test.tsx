import {act,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {expect,test,vi} from "vitest";
import {Binder} from "../src/binder/Binder";
import {A,B,tree,list,listPath,row,part} from "./d18Fixtures";
import {deferred,mockApi,internalError} from "./helpers";
import {reply} from "./d06.fixtures";
async function mount(openChapterId=A,locked=false){const open=vi.fn(),{calls}=mockApi([{method:"GET",path:listPath,reply:reply(list)}]);const ui=render(<Binder tree={tree} openChapterId={openChapterId} locked={locked} onOpenChapter={open}/>);await screen.findByRole("button",{name:"Open Chapter 2"});return {...ui,open,calls};}
test("AXB-0131 AC1 selected chapter follows served order and does not navigate",async()=>{
 const ui=await mount();const a=row(ui.container,A),b=row(ui.container,B),oa=part(a,"chapter-open"),ob=part(b,"chapter-open");
 expect(a).toHaveAttribute("data-selected","true");expect(a.firstElementChild).toHaveAttribute("data-part","selected-rule");expect(a.firstElementChild).toHaveAttribute("aria-hidden","true");
 act(()=>oa.focus());fireEvent.keyDown(oa,{key:"ArrowUp"});expect(ob).toHaveFocus();expect(b).toHaveAttribute("data-selected","true");expect(a.querySelector('[data-part="selected-rule"]')).toBeNull();
 fireEvent.keyDown(ob,{key:"ArrowUp"});expect(ob).toHaveFocus();fireEvent.keyDown(ob,{key:"ArrowDown"});expect(oa).toHaveFocus();fireEvent.keyDown(oa,{key:"ArrowDown"});expect(oa).toHaveFocus();
 expect(oa).toHaveAttribute("aria-current","true");expect(ob).not.toHaveAttribute("aria-current");expect(ui.open).not.toHaveBeenCalled();expect(ui.calls).toHaveLength(1);ui.unmount();
});
test("AXB-0131 AC2 all entry paths, roving focus, and navigation",async()=>{
 for(const entry of ["context","trigger","keyboard","shift"]){const ui=await mount(),b=row(ui.container,B),op=part(b,"chapter-open"),trigger=part(b,"chapter-menu-trigger");
  if(entry==="context")fireEvent.contextMenu(part(b,"count"));else if(entry==="trigger")fireEvent.click(trigger);else fireEvent.keyDown(op,{key:entry==="keyboard"?"ContextMenu":"F10",shiftKey:entry==="shift"});
  const menu=screen.getByRole("menu",{name:"Chapter menu for Chapter 1"}),items=within(menu).getAllByRole("menuitem");
  expect(trigger).toHaveAttribute("aria-expanded","true");expect(trigger).toHaveAttribute("aria-haspopup","menu");expect(items[0]).toHaveFocus();expect(items[0]).toHaveTextContent("Open chapter");expect(items[1]).toHaveTextContent("Pull back to Draft");
  fireEvent.keyDown(items[0],{key:"End"});expect(items[1]).toHaveFocus();fireEvent.keyDown(items[1],{key:"ArrowDown"});expect(items[0]).toHaveFocus();fireEvent.keyDown(items[0],{key:"ArrowUp"});expect(items[1]).toHaveFocus();fireEvent.keyDown(items[1],{key:"Home"});expect(items[0]).toHaveFocus();
  fireEvent.click(items[0]);expect(ui.open.mock.calls).toEqual([[B]]);expect(screen.queryByRole("menu")).toBeNull();expect(ui.calls).toHaveLength(1);ui.unmount();
 }
 for(const locked of [false,true]){const ui=await mount(A,locked);fireEvent.click(part(row(ui.container,A),"chapter-menu-trigger"));const item=screen.getByRole("menuitem",{name:"Open chapter"});expect(item).toHaveAttribute("aria-disabled","true");fireEvent.click(item);expect(ui.open).not.toHaveBeenCalled();ui.unmount();}
});
test("AXB-0131 AC3 Escape, Tab, outside press, collapse and deletion",async()=>{
 const response=deferred<ReturnType<typeof reply>>(),{calls}=mockApi([{method:"GET",path:listPath,reply:(_,n)=>n?response.promise:reply(list)}]);const ui=render(<Binder tree={tree} openChapterId={A}/>);await screen.findByRole("button",{name:"Open Chapter 2"});const a=row(ui.container,A),trigger=part(a,"chapter-menu-trigger"),op=part(a,"chapter-open");
 fireEvent.click(trigger);fireEvent.keyDown(screen.getByRole("menuitem",{name:"Open chapter"}),{key:"Escape"});expect(op).toHaveFocus();
 fireEvent.click(trigger);fireEvent.keyDown(screen.getByRole("menuitem",{name:"Open chapter"}),{key:"Tab"});expect(part(a,"chapter-pull-back")).toHaveFocus();
 fireEvent.click(trigger);fireEvent.pointerDown(part(ui.container,"book-toggle"));expect(screen.queryByRole("menu")).toBeNull();
 fireEvent.click(trigger);fireEvent.click(part(ui.container,"book-toggle"));expect(screen.queryByRole("menu")).toBeNull();expect(part(ui.container,"book-toggle")).toHaveFocus();fireEvent.click(part(ui.container,"book-toggle"));
 fireEvent.click(trigger);await act(async()=>response.resolve(reply({chapters:[list.chapters[0]]})));expect(screen.queryByRole("menu")).toBeNull();expect(part(row(ui.container,B),"chapter-open")).toHaveFocus();expect(calls).toHaveLength(2);ui.unmount();
});
test("AXB-0131 AC4 loading, failure, empty and retry have no menu",async()=>{
 const wait=deferred<ReturnType<typeof reply>>();mockApi([{method:"GET",path:listPath,reply:(_,n)=>n?reply({chapters:[]}):wait.promise}]);const ui=render(<Binder tree={tree}/>);expect(screen.queryByRole("menu")).toBeNull();expect(ui.container.querySelector('[data-part="chapter-menu-trigger"]')).toBeNull();
 await act(async()=>wait.resolve(internalError));expect(ui.container.querySelector('[data-part="chapter-menu-trigger"]')).toBeNull();fireEvent.click(screen.getByRole("button",{name:"Try again"}));await screen.findByRole("button",{name:"Add the first scene"});expect(ui.container.querySelector('[data-part="chapter-menu-trigger"]')).toBeNull();ui.unmount();
});
