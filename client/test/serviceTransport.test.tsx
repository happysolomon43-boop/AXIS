import { expect, test, vi } from "vitest";
import { createSeries, getDraftSync, listSeries, putDraft } from "../src/api/endpoints";
import { request } from "../src/api/http";
import { mockApi } from "./helpers";
import { service } from "./connectionFixtures";

test("AXB-0124 AC1 shared dispatch preserves four endpoint paths, headers and bodies in both modes", async () => {
  for (const configured of [undefined, service]) {
    vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",configured);
    const prefix = configured ?? "/api";
    const draft = "/chapters/ch%2Fa/draft";
    const {calls} = mockApi([
      {method:"GET",path:prefix+"/series",reply:{status:200,body:{series:[]}}},
      {method:"POST",path:prefix+"/series",reply:{status:201,body:{}}},
      {method:"PUT",path:prefix+draft,reply:{status:200,body:{}}},
      {method:"GET",path:prefix+draft+"?view=sync",reply:{status:200,body:{sync:{state:"draft_only",same:false}}}},
    ]);
    await listSeries(); await createSeries("Ashfall"); await putDraft("ch/a","text","ver_00000000000a",1); await getDraftSync("ch/a");
    expect(calls.map(c=>[c.method,c.path,c.body])).toEqual([
      ["GET",prefix+"/series",undefined],["POST",prefix+"/series",{title:"Ashfall"}],
      ["PUT",prefix+draft,{content:"text",base_version:"ver_00000000000a",base_revision:1}],
      ["GET",prefix+draft+"?view=sync",undefined],
    ]);
    calls.forEach(c=>{expect(c.headers.get("x-axis-user")).toBe("usr_alice");expect(c.headers.get("content-type")).toBe(c.body===undefined?null:"application/json");});
    for(const [,init] of vi.mocked(fetch).mock.calls) {
      if(configured) expect(init).toMatchObject({mode:"cors",credentials:"omit",redirect:"error"});
      else { expect(init).not.toHaveProperty("mode");expect(init).not.toHaveProperty("credentials");expect(init).not.toHaveProperty("redirect"); }
    }
  }
});
test("AXB-0124 AC2 rejection, identity and unreadable responses never replay", async () => {
  vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",service);
  const {calls}=mockApi([{method:"POST",path:service+"/series",reply:"network"}]);
  await expect(createSeries("Ashfall")).rejects.toMatchObject({status:0,code:"network"});
  expect(calls).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith(service+"/series",expect.objectContaining({mode:"cors",credentials:"omit",redirect:"error"}));
  const failure={error:{code:"auth_required",message:"identity",details:{example:1}}};
  mockApi([{method:"GET",path:service+"/series",reply:{status:401,body:failure}}]);
  await expect(listSeries()).rejects.toMatchObject({status:401,code:"auth_required",message:"identity",details:{example:1}});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("bad json",{status:200})));
  await expect(request("GET","/series")).rejects.toMatchObject({status:200,code:"unreadable"});
  expect(fetch).toHaveBeenCalledTimes(1);
});
