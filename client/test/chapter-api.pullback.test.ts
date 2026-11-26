import { expect, test, vi } from "vitest";
import { pullBackChapter } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import { mockApi } from "./helpers";
import { internalEnvelope } from "./historyFixtures";
import { chapterNotFoundEnvelope, notInBookEnvelope, pullBackReplyB } from "./pullbackFixtures";

const { id } = pullBackReplyB.body.chapter;
const path = `/api/chapters/${id}/pull-back`;

test("AXB-0070 AC1 sends one encoded POST with no body or content type", async () => {
  const encodedPath = "/api/chapters/a%2Fb/pull-back";
  const { calls } = mockApi([
    { method: "POST", path, reply: pullBackReplyB },
    { method: "POST", path: encodedPath, reply: pullBackReplyB },
  ]);
  expect(await pullBackChapter(id)).toEqual(pullBackReplyB.body);
  expect(calls).toHaveLength(1);
  expect(await pullBackChapter("a/b")).toEqual(pullBackReplyB.body);
  expect(calls.map(({ method, path, headers, body }) => [method, path, headers.get("Content-Type"), body]))
    .toEqual([["POST", path, null, undefined], ["POST", encodedPath, null, undefined]]);
  expect(calls[0].headers.get("X-Axis-User")).toBe("usr_alice");
});

test("AXB-0070 AC2 surfaces API, network and unreadable errors without retrying", async () => {
  const replies = [chapterNotFoundEnvelope, notInBookEnvelope, internalEnvelope, "network"] as const;
  const { calls } = mockApi([{ method: "POST", path, reply: (_, attempt) => replies[attempt] }]);
  for (const [index, [status, code]] of [[404, "not_found"], [409, "not_in_book"], [500, "internal"], [0, "network"]].entries()) {
    const error = await pullBackChapter(id).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code });
    expect(calls).toHaveLength(index + 1);
  }

  const unreadable = vi.fn().mockResolvedValue(new Response("invalid JSON", { status: 200 }));
  vi.stubGlobal("fetch", unreadable);
  const error = await pullBackChapter(id).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 200, code: "unreadable" });
  expect(unreadable).toHaveBeenCalledTimes(1);
});
