import { expect, test, vi } from "vitest";
import { createChapter, createSeries, getSeries, listBookChapters, listSeries } from "../src/api/endpoints";
import {
  bookA, chapterA, chaptersPath, createdChapter, mockApi, seriesA, seriesPath, treeA,
} from "./helpers";

test("AXB-0030 AC2 maps all five endpoint contracts and records matching calls", async () => {
  const chapterRead = vi.fn().mockReturnValue({ status: 200, body: { chapters: [chapterA] } });
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: { status: 200, body: { series: [seriesA] } } },
    { method: "POST", path: seriesPath, reply: { status: 201, body: treeA } },
    { method: "GET", path: /^\/api\/series\/[^/]+$/, reply: { status: 200, body: treeA } },
    { method: "GET", path: chaptersPath, reply: chapterRead },
    { method: "POST", path: chaptersPath, reply: { status: 201, body: createdChapter } },
  ]);

  await expect(listSeries()).resolves.toEqual([seriesA]);
  await expect(createSeries("Ashfall")).resolves.toEqual(treeA);
  await expect(getSeries(seriesA.id)).resolves.toEqual(treeA);
  await expect(getSeries("a/b")).resolves.toEqual(treeA);
  await expect(listBookChapters(bookA.id)).resolves.toEqual([chapterA]);
  await expect(createChapter(bookA.id, "")).resolves.toEqual(createdChapter);
  await expect(listBookChapters(bookA.id)).resolves.toEqual([chapterA]);
  await expect(fetch("/api/x")).rejects.toThrow("unmatched request: GET /api/x");

  expect(calls.map(({ method, path, body }) => [method, path, body])).toEqual([
    ["GET", seriesPath, undefined],
    ["POST", seriesPath, { title: "Ashfall" }],
    ["GET", `${seriesPath}/${seriesA.id}`, undefined],
    ["GET", `${seriesPath}/a%2Fb`, undefined],
    ["GET", chaptersPath, undefined],
    ["POST", chaptersPath, { content: "" }],
    ["GET", chaptersPath, undefined],
    ["GET", "/api/x", undefined],
  ]);
  expect(chapterRead).toHaveBeenNthCalledWith(1, calls[4], 0);
  expect(chapterRead).toHaveBeenNthCalledWith(2, calls[6], 1);
});
