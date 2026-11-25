import { expect, test, vi } from "vitest";
import { getHistory, getVersion } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import type { ChapterHistory, VersionText } from "../src/api/types";
import { reply } from "./d06.fixtures";
import {
  chapterA, histB, historyNone, historyPath, historyThree, internalEnvelope,
  versionNotFoundEnvelope, versionPath, versionTextB, versionTextD,
} from "./historyFixtures";
import { mockApi } from "./helpers";

test("AC1 sends a single bodyless GET per call with both path parameters encoded", async () => {
  const encodedHistory = "/api/chapters/a%2Fb/history";
  const encodedVersion = "/api/chapters/a%2Fb/versions/c%20d";
  const { calls } = mockApi([
    { method: "GET", path: historyPath, reply: reply(historyThree) },
    { method: "GET", path: encodedHistory, reply: reply(historyNone) },
    { method: "GET", path: versionPath(histB.id), reply: reply(versionTextB) },
    { method: "GET", path: encodedVersion, reply: reply(versionTextD) },
  ]);

  expect(await getHistory(chapterA.id)).toEqual(historyThree);
  expect(calls).toHaveLength(1);
  expect(await getHistory("a/b")).toEqual(historyNone);
  expect(calls).toHaveLength(2);
  expect(await getVersion(chapterA.id, histB.id)).toEqual(versionTextB);
  expect(calls).toHaveLength(3);
  expect(await getVersion("a/b", "c d")).toEqual(versionTextD);
  expect(calls.map(({ path }) => path)).toEqual([historyPath, encodedHistory, versionPath(histB.id), encodedVersion]);
  for (const { method, body, headers } of calls) {
    expect(method).toBe("GET");
    expect(body).toBeUndefined();
    expect(headers.has("Content-Type")).toBe(false);
  }
});

test("AC2 preserves error codes without retries and exposes the typed fixtures", async () => {
  const fixtures: [ChapterHistory, ChapterHistory, VersionText, VersionText] =
    [historyThree, historyNone, versionTextB, versionTextD];
  expect(fixtures[0].versions).toHaveLength(3);
  const { calls } = mockApi([
    { method: "GET", path: versionPath(histB.id), reply: versionNotFoundEnvelope },
    { method: "GET", path: historyPath, reply: (_, n) => n === 0 ? internalEnvelope : "network" },
  ]);

  for (const [call, status, code] of [
    [() => getVersion(chapterA.id, histB.id), 404, "not_found"],
    [() => getHistory(chapterA.id), 500, "internal"],
    [() => getHistory(chapterA.id), 0, "network"],
  ] as const) {
    const error = await call().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code });
  }
  expect(calls).toHaveLength(3);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
  await expect(getVersion(chapterA.id, histB.id)).rejects.toMatchObject({ status: 200, code: "unreadable" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
