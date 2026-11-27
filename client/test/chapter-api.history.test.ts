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
  await expect(getVersion("a/b", "c d")).rejects.toMatchObject({ status: 200, code: "unreadable" });
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

test("preview rejects mismatched identity and malformed metadata and admits empty blocks", async () => {
  const good = versionTextB;
  const block = good.blocks[0];
  const cases = [
    { ...good, chapter: { ...good.chapter, id: "ch_00000000000b" } },
    { ...good, chapter: { ...good.chapter, book_id: "bk_00000000000b" } },
    { ...good, version: { ...good.version, id: "ver_00000000000f" } },
    { ...good, version: { ...good.version, chapter_id: "ch_00000000000b" } },
    { ...good, version: { ...good.version, l_seq: Number.MAX_SAFE_INTEGER + 1 } },
    { ...good, version: { ...good.version, version_no: 0 } },
    { ...good, version: { ...good.version, source: "unknown" } },
    { ...good, version: { ...good.version, text_hash: "not-a-hash" } },
    { ...good, version: { ...good.version, hints_hash: "not-a-hash" } },
    { ...good, version: { ...good.version, parent_version: 12 } },
    { ...good, blocks: [block, block] },
    { ...good, blocks: [{ ...block, ordinal: 2 }, block] },
    { ...good, blocks: [{ ...block, ordinal: 1.5 }] },
    { ...good, blocks: [{ ...block, kind: "section" }] },
    { ...good, blocks: [{ ...block, text: null }] },
  ];
  const validEmpty = { ...good, blocks: [] };
  mockApi([{ method: "GET", path: versionPath(histB.id),
    reply: (_, n) => n < cases.length ? reply(cases[n]) : n === cases.length ? reply(good, 201) : reply(validEmpty) }]);
  for (let i = 0; i <= cases.length; i++) {
    await expect(getVersion(chapterA.id, histB.id, good.chapter.book_id)).rejects.toMatchObject({ code: "unreadable" });
  }
  await expect(getVersion(chapterA.id, histB.id, good.chapter.book_id)).resolves.toEqual(validEmpty);
});
