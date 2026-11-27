import { writeResponse } from "./writeFixtures";
import { expect, test, vi } from "vitest";
import { restoreVersion } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import { mockApi } from "./helpers";
import { chapterA } from "./historyFixtures";
import { internalEnvelope, restorePath, restoreReply, restoreReplyCp, rowB, versionNotFoundEnvelope } from "./restoreFixtures";

const requestId = "11111111-1111-4111-8111-111111111111";

test("AC1 sends one JSON POST with the chapter id encoded and returns the restore envelope body", async () => {
  const encoded = "/api/chapters/a%2Fb/restore";
  const { calls } = mockApi([
    { method: "POST", path: restorePath, reply: call => writeResponse(call, restoreReply) },
    { method: "POST", path: encoded, reply: restoreReplyCp },
  ]);

  expect(await restoreVersion(chapterA.id, chapterA.book_id, rowB.id, requestId)).toMatchObject({ ...restoreReply.body, request_id: requestId, operation: "restore" });
  expect(calls).toHaveLength(1);
  await expect(restoreVersion("a/b", chapterA.book_id, "c d", requestId)).rejects.toMatchObject({ code: "unreadable" });
  expect(calls.map(({ method, path, body, headers }) => ({
    method, path, body, contentType: headers.get("Content-Type"),
  }))).toEqual([
    { method: "POST", path: restorePath, body: { version_id: rowB.id, request_id: requestId }, contentType: "application/json" },
    { method: "POST", path: encoded, body: { version_id: "c d", request_id: requestId }, contentType: "application/json" },
  ]);
});

test("AC2 surfaces API, network and unreadable failures with one request per call", async () => {
  const chapterNotFound = {
    status: 404, body: { error: { code: "not_found", message: "Chapter not found", details: null } },
  };
  const replies = [versionNotFoundEnvelope, internalEnvelope, "network", chapterNotFound] as const;
  const { calls } = mockApi([{ method: "POST", path: restorePath, reply: (_, attempt) => replies[attempt] }]);

  for (const [index, [status, code]] of [[404, "not_found"], [500, "internal"], [0, "network"], [404, "not_found"]].entries()) {
    const error = await restoreVersion(chapterA.id, chapterA.book_id, rowB.id, requestId).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code });
    expect(calls).toHaveLength(index + 1);
  }

  const unreadable = vi.fn().mockResolvedValue(new Response("invalid JSON", { status: 201 }));
  vi.stubGlobal("fetch", unreadable);
  await expect(restoreVersion(chapterA.id, chapterA.book_id, rowB.id, requestId)).rejects.toMatchObject({ status: 201, code: "unreadable" });
  expect(unreadable).toHaveBeenCalledTimes(1);
});
