import { afterEach, expect, test, vi } from "vitest";
import { getDraft, getDraftSync } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import { chapterA, reply } from "./d06.fixtures";
import { draftNone, draftPath } from "./draftFixtures";
import { mockApi } from "./helpers";
import { internalEnvelope } from "./historyFixtures";
import { chapterNotFoundEnvelope } from "./pullbackFixtures";
import { syncDraftOnly, syncInBook, syncEdited, syncRevisedSame, syncRevised, withSync } from "./syncDraftFixtures";

const path = draftPath + "?view=sync";
afterEach(() => vi.unstubAllGlobals());
test("AXB-0084 AC1 five exact pairs and encoded ID", async () => {
  for (const sync of [syncDraftOnly, syncInBook, syncEdited, syncRevisedSame, syncRevised]) {
    const { calls } = mockApi([{ method: "GET", path, reply: reply({ sync }) }]);
    expect(await getDraftSync(chapterA.id)).toEqual(sync);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path, body: undefined });
    expect(calls[0].headers.get("X-Axis-User")).toBe("usr_alice");
    expect(calls[0].headers.has("Content-Type")).toBe(false);
  }
  const encoded = "/api/chapters/a%2Fb/draft?view=sync";
  const { calls } = mockApi([{ method: "GET", path: encoded, reply: reply({ sync: syncInBook }) }]);
  expect(await getDraftSync("a/b")).toEqual(syncInBook);
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(encoded);
});
test("AXB-0084 AC2 rejects malformed payloads and preserves request errors", async () => {
  for (const body of [{}, null, [], { sync: null }, { ...draftNone, sync: syncInBook },
    { sync: { ...syncEdited, extra: true } }, { sync: { state: "edited", same: true } },
    { sync: { state: "draft_only", same: true } }, { sync: { state: "in_book", same: false } },
    { sync: { state: "unknown", same: false } }, { sync: { state: "being_revised", same: "true" } }]) {
    const { calls } = mockApi([{ method: "GET", path, reply: reply(body) }]);
    expect(await getDraftSync(chapterA.id)).toBeNull();
    expect(calls).toHaveLength(1);
  }
  for (const [response, code, status] of [
    [reply({ error: { code: "auth_required", message: "Missing or invalid X-Axis-User header", details: null } }, 401), "auth_required", 401],
    [chapterNotFoundEnvelope, "not_found", 404], [internalEnvelope, "internal", 500], ["network", "network", 0],
  ] as const) {
    const { calls } = mockApi([{ method: "GET", path, reply: response }]);
    const result = getDraftSync(chapterA.id);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ code, status, details: null });
    expect(calls).toHaveLength(1);
  }
  const unreadable = vi.fn(async () => new Response("not json", { status: 200 }));
  vi.stubGlobal("fetch", unreadable);
  await expect(getDraftSync(chapterA.id)).rejects.toMatchObject({ code: "unreadable", status: 200, details: null });
  expect(unreadable).toHaveBeenCalledTimes(1);
  const full = withSync(reply(draftNone) as {status: number; body: typeof draftNone}, syncInBook);
  const { calls } = mockApi([{ method: "GET", path: draftPath, reply: full }]);
  expect(await getDraft(chapterA.id)).toEqual(full.body);
  expect(calls.map(c => c.path)).toEqual([draftPath]);
});
