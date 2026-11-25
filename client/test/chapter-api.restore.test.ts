import { expect, test, vi } from "vitest";
import { restoreVersion } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import { mockApi } from "./helpers";
import { chapterA } from "./historyFixtures";
import { internalEnvelope, restorePath, restoreReply, restoreReplyCp, rowB, versionNotFoundEnvelope } from "./restoreFixtures";

test("AC1 sends one JSON POST with the chapter id encoded and returns the restore envelope body", async () => {
  const encoded = "/api/chapters/a%2Fb/restore";
  const { calls } = mockApi([
    { method: "POST", path: restorePath, reply: restoreReply },
    { method: "POST", path: encoded, reply: restoreReplyCp },
  ]);

  expect(await restoreVersion(chapterA.id, rowB.id)).toEqual(restoreReply.body);
  expect(calls).toHaveLength(1);
  expect(await restoreVersion("a/b", "c d")).toEqual(restoreReplyCp.body);
  expect(calls.map(({ method, path, body, headers }) => ({
    method, path, body, contentType: headers.get("Content-Type"),
  }))).toEqual([
    { method: "POST", path: restorePath, body: { version_id: rowB.id }, contentType: "application/json" },
    { method: "POST", path: encoded, body: { version_id: "c d" }, contentType: "application/json" },
  ]);
});

test("AC2 surfaces API, network and unreadable failures with one request per call", async () => {
  const chapterNotFound = {
    status: 404, body: { error: { code: "not_found", message: "Chapter not found", details: null } },
  };
  const replies = [versionNotFoundEnvelope, internalEnvelope, "network", chapterNotFound] as const;
  const { calls } = mockApi([{ method: "POST", path: restorePath, reply: (_, attempt) => replies[attempt] }]);

  for (const [index, [status, code]] of [[404, "not_found"], [500, "internal"], [0, "network"], [404, "not_found"]].entries()) {
    const error = await restoreVersion(chapterA.id, rowB.id).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code });
    expect(calls).toHaveLength(index + 1);
  }

  const unreadable = vi.fn().mockResolvedValue(new Response("invalid JSON", { status: 201 }));
  vi.stubGlobal("fetch", unreadable);
  await expect(restoreVersion(chapterA.id, rowB.id)).rejects.toMatchObject({ status: 201, code: "unreadable" });
  expect(unreadable).toHaveBeenCalledTimes(1);
});
