import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type {
  ActivationWritten, BookChapters, ChapterCreated, ChapterHistory, ChapterRow, VersionWritten,
} from "../src/corpus/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { intakeCounts, seedSeries, story } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
const json = { ...alice, "content-type": "application/json" };
let app: FastifyInstance;
let seriesId: string;
let bookId: string;

beforeEach(async () => {
  await resetDb(pool);
  app = buildApp({ pool });
  ({ seriesId, bookId } = await seedSeries(pool));
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

async function create(content: string) {
  const response = await app.inject({
    method: "POST", url: `/books/${bookId}/chapters`, headers: json, payload: { content },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ChapterCreated>();
}

async function write(id: string, action: "send" | "versions", content: string) {
  const response = await app.inject({
    method: "POST", url: `/chapters/${id}/${action}`, headers: json, payload: { content },
  });
  expect(response.statusCode).toBe(201);
  return response.json<VersionWritten>();
}

async function deactivate(id: string) {
  const response = await app.inject({
    method: "POST", url: `/chapters/${id}/activate`, headers: json, payload: { version_id: null },
  });
  expect(response.statusCode).toBe(200);
  return response.json<ActivationWritten>();
}

async function chapterOnly() {
  const { rows: [row] } = await pool.query<{ result: { ids: string[] } }>(
    "SELECT commit_inputs($1, 'corpus', 'usr_alice', 'chapter.create', $2::jsonb) AS result",
    [seriesId, JSON.stringify([{ kind: "chapter", book_id: bookId }])],
  );
  return row!.result.ids[0]!;
}

function get(url: string, headers?: Record<string, string>) {
  return app.inject({ method: "GET", url, headers });
}

async function list() {
  const response = await get(`/books/${bookId}/chapters`, alice);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<BookChapters>().chapters;
}

async function history(chapterId: string) {
  const response = await get(`/chapters/${chapterId}/history`, alice);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ChapterHistory>();
}

async function expectReadDenials(
  path: (id: string) => string,
  existing: string,
  missing: string,
  message: "Book not found" | "Chapter not found",
) {
  const before = await intakeCounts(pool);
  const anonymous = await get(path(existing));
  expect(anonymous.statusCode).toBe(401);
  expect(anonymous.json().error.code).toBe("auth_required");
  expect(await intakeCounts(pool)).toEqual(before);

  const notFound = { error: { code: "not_found", message, details: null } };
  const denied = await get(path(existing), bob);
  expect(denied.statusCode).toBe(404);
  expect(denied.json()).toEqual(notFound);
  expect(await intakeCounts(pool)).toEqual(before);
  for (const id of [missing, "not-an-id", "%00", "a".repeat(65)]) {
    const response = await get(path(id), alice);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(notFound);
    expect(await intakeCounts(pool)).toEqual(before);
  }
  const tooLong = await get(path("a".repeat(101)), alice);
  expect(tooLong.statusCode).toBe(404);
  expect(tooLong.json()).toEqual({ error: { code: "not_found", message: "Route not found", details: null } });
  expect(await intakeCounts(pool)).toEqual(before);
}

test("AC1 lists chapters with latest metadata and a separate activation state", async () => {
  const first = await create(story);
  const second = await create("abc");
  const third = await create("");
  const fourthId = await chapterOnly();
  expect(await list()).toEqual([
    { ...first.chapter, title: "Chapter One", word_count: 10, version_id: first.version.id, active_version_id: null, sync: { state: "draft_only", same: false } },
    { ...second.chapter, title: null, word_count: 1, version_id: second.version.id, active_version_id: null, sync: { state: "draft_only", same: false } },
    { ...third.chapter, title: null, word_count: 0, version_id: third.version.id, active_version_id: null, sync: { state: "draft_only", same: false } },
    {
      id: fourthId, book_id: bookId, order_key: "0000004000",
      title: null, word_count: 0, version_id: null, active_version_id: null, sync: { state: "draft_only", same: false },
    },
  ]);
  const id = first.chapter.id;
  const sent = await write(id, "send", "## Part\n\nx");
  expect((await list())[0]).toEqual({
    ...first.chapter, title: "Part", word_count: 2, version_id: sent.version.id, active_version_id: sent.version.id, sync: { state: "in_book", same: true },
  });
  const saved = await write(id, "versions", "hello");
  expect((await list())[0]).toEqual({
    ...first.chapter, title: null, word_count: 1, version_id: saved.version.id, active_version_id: sent.version.id, sync: { state: "edited", same: false },
  });

  await deactivate(id);
  expect((await list())[0]?.active_version_id).toBeNull();
  for (const [content, title] of [
    ["text\n\n# H", null], ["#  spaced  title  ", "spaced  title"], ["* * *\n\nA", null],
  ] as const) {
    const created = await create(content);
    expect((await list()).find((chapter) => chapter.id === created.chapter.id)?.title).toBe(title);
  }
});

test("AC2 handles empty lists, owner checks, bytewise tie order, and read-only requests", async () => {
  await expectReadDenials((id) => `/books/${id}/chapters`, bookId, "bk_000000000000", "Book not found");
  const beforeEmpty = await intakeCounts(pool);
  const empty = await get(`/books/${bookId}/chapters`, alice);
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual({ chapters: [] });
  expect(await intakeCounts(pool)).toEqual(beforeEmpty);

  const first = await create("abc");
  const { rows: [second] } = await pool.query<ChapterRow>(
    "INSERT INTO chapters (book_id, order_key) VALUES ($1, $2) RETURNING id, book_id, order_key",
    [bookId, first.chapter.order_key],
  );
  const beforeList = await intakeCounts(pool);
  expect((await list()).map(({ id }) => id)).toEqual([first.chapter.id, second!.id].sort());
  expect(await intakeCounts(pool)).toEqual(beforeList);
});

test("AC3 reads newest-first version metadata, ledger dates, and counts", async () => {
  const first = await create("abc");
  const id = first.chapter.id;
  const second = await write(id, "versions", "hello");
  const third = await write(id, "send", "hello again");
  expect(third.version).toMatchObject({ parent_version: second.version.id, l_seq: 3, source: "send" });
  const { rows: ledger } = await pool.query<{ l_seq: number; at: Date }>(
    "SELECT l_seq::int, at FROM ledger WHERE series_id = $1 ORDER BY l_seq", [seriesId],
  );
  const dates = new Map(ledger.map(({ l_seq, at }) => [l_seq, at.toISOString()]));
  expect(await history(id)).toEqual({
    chapter: first.chapter,
    active_version_id: third.version.id,
    versions: [
      { ...third.version, at: dates.get(3), word_count: 2, snapshot: null, can_name_snapshot: false },
      { ...second.version, at: dates.get(2), word_count: 1, snapshot: null, can_name_snapshot: true },
      { ...first.version, at: dates.get(1), word_count: 1, snapshot: null, can_name_snapshot: false },
    ],
  });

  await deactivate(id);
  expect((await history(id)).active_version_id).toBeNull();
  const emptyId = await chapterOnly();
  expect(await history(emptyId)).toEqual({
    chapter: { id: emptyId, book_id: bookId, order_key: "0000002000" },
    active_version_id: null, versions: [],
  });
  const emptyText = await create("");
  const emptyTextVersions = (await history(emptyText.chapter.id)).versions;
  expect(emptyTextVersions).toHaveLength(1);
  expect(emptyTextVersions[0]?.word_count).toBe(0);
});

test("AC4 denies non-owners and invalid chapter IDs while preserving all data", async () => {
  const { chapter } = await create("abc");
  await expectReadDenials((id) => `/chapters/${id}/history`, chapter.id, "ch_000000000000", "Chapter not found");
  const before = await intakeCounts(pool);
  expect((await history(chapter.id)).versions).toHaveLength(1);
  expect(await intakeCounts(pool)).toEqual(before);
});
