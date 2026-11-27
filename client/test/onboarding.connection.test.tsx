import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import { book, series, service } from "./connectionFixtures";
import { deferred, internalError, mockApi } from "./helpers";

const list=service+"/series", detail=list+"/"+series.id, chapters=service+"/books/"+book.id+"/chapters";
const empty={status:200,body:{series:[]}}, owned={status:200,body:{series:[series]}}, tree={status:200,body:{series,books:[book]}};
const chapterList={method:"GET",path:chapters,reply:{status:200,body:{chapters:[]}}};
const identity={status:401,body:{error:{code:"auth_required",message:"private",details:null}}};
const notFound={status:404,body:{error:{code:"not_found",message:"private",details:null}}};
const failed="Your workspace could not be opened.";
const key="axis.lastSeriesId";
function direct(){vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",service);}
test("AXB-0125 AC1 verified empty Bob opens only Onboarding",async()=>{
  direct();vi.stubEnv("VITE_AXIS_USER","usr_bob");
  const {calls}=mockApi([{method:"GET",path:list,reply:empty}]);
  render(<App/>);
  const title=await screen.findByRole("textbox",{name:"Title"});
  await waitFor(()=>expect(title).toHaveFocus());
  expect(calls.map(c=>[c.method,c.path,c.headers.get("x-axis-user")])).toEqual([["GET",list,"usr_bob"]]);
});
test("AXB-0125 AC2 absent, unmatched and matching remembered IDs",async()=>{
  direct();
  const other={...series,id:"ser_00000000000b",title:"A Different Series"};
  for(const stored of [null,"ser_00000000000z",series.id]){
    if(stored) localStorage.setItem(key,stored);
    const held=deferred<typeof tree>();
    const {calls}=mockApi([
      {method:"GET",path:list,reply:stored===series.id?{status:200,body:{series:[other,series]}}:owned},
      {method:"GET",path:detail,reply:()=>held.promise},chapterList,
    ]);
    render(<App/>);
    expect(screen.getByRole("status")).toHaveTextContent("Opening your workspace…");
    await waitFor(()=>expect(calls.map(c=>c.path)).toEqual([list,detail]));
    expect(screen.queryByRole("form")).toBeNull();
    await act(async()=>held.resolve(tree));
    expect(await screen.findByRole("button",{name:"Binder"})).toBeInTheDocument();
    expect(screen.getByText("Ashfall")).toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(series.id);
    cleanup();localStorage.clear();
  }
});
test("AXB-0125 AC3 failure matrix never hands off or clears remembered id",async()=>{
  direct();
  const variants:[unknown,unknown,string][]=[
    [identity,tree,"Your workspace identity could not be verified."],
    [owned,identity,"Your workspace identity could not be verified."],
    [owned,notFound,"That series could not be opened."],
    [notFound,tree,failed],[internalError,tree,failed],["network",tree,failed],
    [owned,"network",failed],[owned,internalError,failed],
    ...[{},null,{series:null},{series:[{}]},{series:[{...series,foundation:[]}]},{series:[{...series,genre_rubric_id:4}]}].map(body=>[{status:200,body},tree,failed] as [unknown,unknown,string]),
    [{status:201,body:{series:[]}},tree,failed], [owned,{status:201,body:tree.body},failed],
    ...[{},null,{series,books:null},{series:{...series,id:"wrong"},books:[]},{series,books:[{...book,status:"unknown"}]},
      {series,books:[{...book,series_id:"wrong"}]},{series,books:[{...book,ordinal:1.2}]},{series,books:[{...book,label:4}]}].map(body=>[owned,{status:200,body},failed] as [unknown,unknown,string]),
  ];
  for(const key of Object.keys(series)) {
    const missing={...series} as Record<string,unknown>;delete missing[key];
    variants.push([{status:200,body:{series:[missing]}},tree,failed]);
    variants.push([{status:200,body:{series:[{...series,[key]:key==="foundation"?null:42}]}},tree,failed]);
  }
  for(const key of Object.keys(book)) {
    const missing={...book} as Record<string,unknown>;delete missing[key];
    variants.push([owned,{status:200,body:{series,books:[missing]}},failed]);
    variants.push([owned,{status:200,body:{series,books:[{...book,[key]:key==="ordinal"?"1":42}]}},failed]);
  }
  type Reply={status:number;body:unknown}|"network";
  for(const [first,second,message] of variants){
    localStorage.setItem(key,series.id);
    const {calls}=mockApi([{method:"GET",path:list,reply:first as Reply},{method:"GET",path:detail,reply:second as Reply}]);
    const ui=render(<App/>);
    const alert=await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button",{name:"Try again"})).toBeInTheDocument();
    expect(ui.container.querySelector('[data-surface="onboarding"],[data-surface="shell"]')).toBeNull();
    expect(localStorage.getItem(key)).toBe(series.id);
    expect(calls.every(c=>c.method==="GET")).toBe(true);
    expect(document.body).toHaveFocus();
    cleanup();localStorage.clear();
  }
});
test("AXB-0125 AC3 retry is list-first once, preserves focus on failure, and hands off focus",async()=>{
  direct();
  for(const recover of [empty,owned]){
    const pending=deferred<typeof internalError>(), success=deferred<typeof recover>();
    const {calls}=mockApi([{method:"GET",path:list,reply:(_,n)=>n===0?internalError:n===1?pending.promise:success.promise},
      {method:"GET",path:detail,reply:tree},chapterList]);
    const user=userEvent.setup();render(<App/>);
    const button=await screen.findByRole("button",{name:"Try again"});
    button.focus();await user.keyboard("{Enter}");await user.keyboard(" ");
    expect(calls.map(c=>c.path)).toEqual([list,list]);
    expect(button).toHaveFocus();expect(button).toHaveAttribute("aria-disabled","true");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async()=>pending.resolve(internalError));
    expect(screen.getByRole("button",{name:"Try again"})).toBe(button);
    expect(button).toHaveFocus();expect(button).not.toHaveAttribute("aria-disabled");
    fireEvent.click(button);await act(async()=>success.resolve(recover));
    const destination=recover===empty?await screen.findByRole("textbox",{name:"Title"}):await screen.findByRole("button",{name:"Binder"});
    await waitFor(()=>expect(destination).toHaveFocus());
    expect(calls.filter(c=>c.path===list)).toHaveLength(3);
    expect(calls.every(c=>c.method==="GET")).toBe(true);
    cleanup();
  }
});
test("AXB-0125 AC4 unmounted list and detail success or rejection do nothing",async()=>{
  direct();
  for(const stage of ["list","detail"])for(const reject of [false,true]){
    const held=deferred<{status:number;body:unknown}>();
    const {calls}=mockApi([{method:"GET",path:list,reply:()=>stage==="list"?held.promise:owned},
      {method:"GET",path:detail,reply:()=>held.promise}]);
    const ui=render(<App/>);
    await waitFor(()=>expect(calls).toHaveLength(stage==="list"?1:2));
    ui.unmount();
    await act(async()=>{if(reject)held.reject(new Error("late"));else held.resolve(stage==="list"?owned:tree);});
    expect(calls).toHaveLength(stage==="list"?1:2);
    expect(localStorage.getItem(key)).toBeNull();expect(document.body).toHaveFocus();
  }
});
