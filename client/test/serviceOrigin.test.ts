import { expect, test, vi } from "vitest";
import { ConfigError } from "../src/identity";
import { request } from "../src/api/http";
import { readServiceOrigin, serviceTarget } from "../src/api/serviceOrigin";
import { service } from "./connectionFixtures";

test("AXB-0123 AC1 exact targets and options", () => {
  const path = "/chapters/ch_00000000000a/draft?view=sync";
  expect(serviceTarget(readServiceOrigin(service), path)).toEqual({url:service+path,options:{mode:"cors",credentials:"omit",redirect:"error"}});
  for (const setting of [undefined,""]) expect(serviceTarget(readServiceOrigin(setting),path)).toEqual({url:"/api"+path,options:{}});
  const encoded = "/series/a%2Fb?z=%2F&z=%2f";
  expect(serviceTarget(service,encoded).url).toBe(service+encoded);
});
test("AXB-0123 AC2 invalid configuration and paths never fetch", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch",fetch);
  for (const raw of ["http://localhost:3000","https://axis.example.test/","https://axis.example.test/a",
    "https://u@axis.example.test"," https://axis.example.test","https://AXIS.example.test",
    "https://axis.example.test:443","https://axis.example.test?x","https://axis.example.test#x","https://*.example.test"]) {
    expect(() => readServiceOrigin(raw)).toThrow(ConfigError);
    expect(() => readServiceOrigin(raw)).toThrow("The service address is invalid.");
    vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",raw);
    await expect(request("GET","/series")).rejects.toThrow("The service address is invalid.");
  }
  vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",service);
  for (const path of ["//other.example.test/a","series","/a\\b","/a#b","/a\n","/a\x7f"]) {
    expect(() => serviceTarget(service,path)).toThrow("Invalid service path.");
    await expect(request("GET",path)).rejects.toThrow(ConfigError);
  }
  expect(fetch).not.toHaveBeenCalled();
});
