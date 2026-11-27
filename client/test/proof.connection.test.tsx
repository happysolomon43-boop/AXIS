import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import { book, expectedTrace, series, service } from "./connectionFixtures";
import { mockApi } from "./helpers";

test("AXB-0126 AC2 same named Connection trace: list failure then explicit retry, original Binder",async()=>{
  const originalFetch=globalThis.fetch;
  vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",service);
  localStorage.removeItem("axis.lastSeriesId");
  const served:unknown[]=[];
  const {calls}=mockApi([
    {method:"GET",path:service+"/series",reply:(_,n)=>{const step=expectedTrace[n];served.push(step);return {status:step.status,body:step.body};}},
    {method:"GET",path:service+"/series/"+series.id,reply:()=>{const step=expectedTrace[2];served.push(step);return {status:step.status,body:step.body};}},
    {method:"GET",path:service+"/books/"+book.id+"/chapters",reply:{status:200,body:{chapters:[]}}},
  ]);
  try{
    render(<App/>);
    expect((await screen.findByRole("alert")).textContent).toBe("Your workspace could not be opened.");
    expect(calls.map(c=>[c.method,c.path])).toEqual([["GET",service+"/series"]]);
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Try again"}));
    const door=await screen.findByRole("button",{name:"Binder"});
    await waitFor(()=>expect(door).toHaveFocus());
    expect(screen.getByText("Ashfall")).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"The Third Bell"})).toBeInTheDocument();
    expect(served).toEqual(expectedTrace);
    expect(calls.slice(0,3).map(c=>[c.method,c.path,c.headers.get("x-axis-user")])).toEqual(expectedTrace.map(s=>["GET",service+s.path,"usr_alice"]));
    expect(calls.every(c=>c.method==="GET")).toBe(true);
    expect(localStorage.getItem("axis.lastSeriesId")).toBe(series.id);
  }finally{cleanup();vi.unstubAllGlobals();vi.unstubAllEnvs();localStorage.clear();}
  expect(globalThis.fetch).toBe(originalFetch);
  expect(localStorage).toHaveLength(0);
});
