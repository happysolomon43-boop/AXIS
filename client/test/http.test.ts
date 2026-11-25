import { expect, test, vi } from "vitest";
import { ApiError, request } from "../src/api/http";
import { ConfigError, getUserId } from "../src/identity";
import { mockApi, seriesPath } from "./helpers";

test("AXB-0030 AC1 sends one request and preserves the API error envelope", async () => {
  const reads = mockApi([{ method: "GET", path: seriesPath, reply: { status: 200, body: { series: [] } } }]);
  await expect(request("GET", "/series")).resolves.toEqual({ series: [] });
  expect(reads.calls).toHaveLength(1);
  expect(reads.calls[0]).toMatchObject({ method: "GET", path: seriesPath, body: undefined });
  expect(reads.calls[0].headers.get("X-Axis-User")).toBe("usr_alice");
  expect(reads.calls[0].headers.has("Content-Type")).toBe(false);

  const writes = mockApi([{ method: "POST", path: seriesPath, reply: { status: 201, body: {} } }]);
  await request("POST", "/series", { title: "Ashfall" });
  expect(writes.calls).toHaveLength(1);
  expect(writes.calls[0].headers.get("Content-Type")).toBe("application/json");
  expect(writes.calls[0].body).toEqual({ title: "Ashfall" });

  const details = { errors: [{ path: "/title", message: "x" }] };
  const cases = [
    {
      reply: { status: 404, body: { error: { code: "not_found", message: "Book not found", details: null } } },
      expected: { status: 404, code: "not_found", message: "Book not found", details: null },
    },
    {
      reply: { status: 400, body: { error: { code: "validation_failed", message: "Invalid", details } } },
      expected: { status: 400, code: "validation_failed", message: "Invalid", details },
    },
    {
      reply: { status: 500, body: {} },
      expected: { status: 500, code: "unreadable", message: "Unreadable error response", details: null },
    },
    {
      reply: "network",
      expected: { status: 0, code: "network", message: "Failed to fetch", details: null },
    },
  ] as const;
  for (const { reply, expected } of cases) {
    const { calls } = mockApi([{ method: "GET", path: seriesPath, reply }]);
    const result = request("GET", "/series");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject(expected);
    expect(calls).toHaveLength(1);
  }

  for (const status of [200, 500]) {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("unparseable", { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(request("GET", "/series")).rejects.toMatchObject({ status, code: "unreadable", details: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  }

  vi.stubEnv("VITE_AXIS_USER", "bogus");
  expect(getUserId).toThrow(ConfigError);
  expect(getUserId).toThrow("VITE_AXIS_USER must match ^usr_[a-z0-9]{2,32}$");
});
