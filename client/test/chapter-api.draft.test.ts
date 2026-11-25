import { expect, test, vi } from "vitest";
import { getDraft, putDraft } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import type { DraftDetail, DraftWritten } from "../src/api/types";
import { b, reply } from "./d06.fixtures";
import { chapterA, conflictEnvelope, draftHeadB, draftNone, draftPath, putOk } from "./draftFixtures";
import { mockApi } from "./helpers";

test("AC1 reads and writes the draft with one request, encoded IDs and the exact JSON body", async () => {
  const encoded = "/api/chapters/a%2Fb/draft";
  const { calls } = mockApi([
    { method: "GET", path: draftPath, reply: reply(draftNone) },
    { method: "GET", path: encoded, reply: reply(draftHeadB) },
    { method: "PUT", path: draftPath, reply: reply(putOk(1)) },
    { method: "PUT", path: encoded, reply: reply(putOk(2)) },
  ]);
  expect(await getDraft(chapterA.id)).toEqual(draftNone);
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.has("Content-Type")).toBe(false);
  expect(await getDraft("a/b")).toEqual(draftHeadB);
  expect(calls).toHaveLength(2);
  expect(calls[1].headers.has("Content-Type")).toBe(false);

  expect(await putDraft(chapterA.id, "Hello", b, 0)).toEqual(putOk(1));
  expect(calls).toHaveLength(3);
  expect(calls[2].headers.get("Content-Type")).toBe("application/json");
  expect(vi.mocked(fetch).mock.calls[2][1]?.body)
    .toBe(`{"content":"Hello","base_version":"${b}","base_revision":0}`);
  expect(await putDraft("a/b", "", b, 1)).toEqual(putOk(2));
  expect(calls.map(({ method, path, body }) => [method, path, body])).toEqual([
    ["GET", draftPath, undefined],
    ["GET", encoded, undefined],
    ["PUT", draftPath, { content: "Hello", base_version: b, base_revision: 0 }],
    ["PUT", encoded, { content: "", base_version: b, base_revision: 1 }],
  ]);
});

test("AC2 exposes conflict details and the not-found code through ApiError", async () => {
  const fixtures: [DraftDetail, DraftDetail, DraftWritten] = [draftNone, draftHeadB, putOk(2)];
  expect(fixtures[2].revision).toBe(2);
  const missing = "/api/chapters/missing/draft";
  const { calls } = mockApi([
    { method: "PUT", path: draftPath, reply: conflictEnvelope },
    { method: "GET", path: missing, reply: reply({ error: { code: "not_found", message: "Chapter not found" } }, 404) },
  ]);
  const conflict = await putDraft(chapterA.id, "Hello", b, 0).catch((error: unknown) => error);
  expect(conflict).toBeInstanceOf(ApiError);
  expect(conflict).toMatchObject({
    status: 409, code: "conflict", details: { reason: "revision", current_version: b, current_revision: 1 },
  });
  const notFound = await getDraft("missing").catch((error: unknown) => error);
  expect(notFound).toBeInstanceOf(ApiError);
  expect(notFound).toMatchObject({ status: 404, code: "not_found" });
  expect(calls).toHaveLength(2);
});
