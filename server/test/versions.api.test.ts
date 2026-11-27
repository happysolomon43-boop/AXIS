import { writeGuard } from "./helpers.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createChapterWithFirstVersion, type ChapterCreated, type VersionWritten } from "../src/corpus/repo.js";
import type { VersionText } from "../src/versions/repository.js";
import { makePool, resetDb } from "./helpers.js";
import { emptyHash, intakeCounts, seedSeries } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
const initial = "# Title\n\nOne\n\n---\n\nTwo";
const revised = "# Title\n\nOne!";
let app: FastifyInstance;
let first: ChapterCreated;
let empty: ChapterCreated;
let next: VersionWritten;
const readPool = { query: pool.query.bind(pool), connect: vi.fn(() => pool.connect()) };

beforeEach(async () => {
  await resetDb(pool);
  const { bookId, seriesId } = await seedSeries(pool);
  await seedSeries(pool, "usr_bob");
  const book = { id: bookId, series_id: seriesId };
  first = await createChapterWithFirstVersion(pool, alice["x-axis-user"], book, initial, "draft_edit");

  const setup = buildApp({ pool });
  try {
    const written = await setup.inject({
      method: "POST", url: `/chapters/${first.chapter.id}/versions`, headers: alice,
      payload: { content: revised, ...writeGuard(first.version.id), parent_version: first.version.id },
    });
    expect(written.statusCode, written.body).toBe(201);
    next = written.json<VersionWritten>();
    const kept = await setup.inject({
      method: "PUT", url: `/chapters/${first.chapter.id}/draft`, headers: alice,
      payload: { content: "# Title\n\nOne!!", base_version: next.version.id, base_revision: 0 },
    });
    expect(kept.statusCode, kept.body).toBe(200);
  } finally {
    await setup.close();
  }
  empty = await createChapterWithFirstVersion(pool, alice["x-axis-user"], book, "", "draft_edit");
  readPool.connect.mockClear();
  app = buildApp({ pool: readPool as unknown as Pool });
});

afterEach(() => app.close());
afterAll(() => pool.end());

function read(chapterId: string, versionId: string, headers: Record<string, string> = alice) {
  return app.inject({ method: "GET", url: `/chapters/${chapterId}/versions/${versionId}`, headers });
}

async function state() {
  const { rows: drafts } = await pool.query("SELECT * FROM chapter_drafts ORDER BY chapter_id");
  return { ...await intakeCounts(pool), drafts };
}

test("AC1 returns exactly the chosen version and its stored blocks, independently of the head", async () => {
  const before = await state();
  const old = await read(first.chapter.id, first.version.id);
  expect(old.statusCode, old.body).toBe(200);
  expect(old.json<VersionText>()).toEqual({
    chapter: { id: first.chapter.id, book_id: first.chapter.book_id, order_key: "0000001000" },
    version: {
      id: first.version.id, chapter_id: first.chapter.id, version_no: 1, source: "draft_edit",
      text_hash: expect.stringMatching(/^[0-9a-f]{64}$/), hints_hash: emptyHash,
      parent_version: null, l_seq: first.version.l_seq,
    },
    blocks: [
      { ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "One" },
      { ordinal: 3, kind: "scene_break", text: "---" }, { ordinal: 4, kind: "paragraph", text: "Two" },
    ],
  });

  const current = await read(first.chapter.id, next.version.id);
  expect(current.statusCode).toBe(200);
  expect(current.json()).toEqual({
    chapter: first.chapter,
    version: { ...next.version, version_no: 2, parent_version: first.version.id },
    blocks: [{ ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "One!" }],
  });
  const blank = await read(empty.chapter.id, empty.version.id);
  expect(blank.statusCode).toBe(200);
  expect(blank.json()).toEqual({ chapter: empty.chapter, version: { ...empty.version, text_hash: emptyHash }, blocks: [] });
  expect(await state()).toEqual(before);
});

test("AC2 enforces identity, ownership, error order and path limits before the version read", async () => {
  const before = await state();
  const { id } = first.chapter;
  const v1 = first.version.id;
  const auth = await read(id, v1, {});
  expect(auth.statusCode).toBe(401);
  expect(auth.json()).toEqual({
    error: { code: "auth_required", message: "Missing or invalid X-Axis-User header", details: null },
  });

  for (const [chapter, version, headers, message] of [
    [id, v1, bob, "Chapter not found"],
    [id, "v".repeat(65), bob, "Chapter not found"],
    ["ch_000000000000", v1, alice, "Chapter not found"],
    ["c".repeat(65), v1, alice, "Chapter not found"],
    ["ch_%00", v1, alice, "Chapter not found"],
    [id, "v".repeat(65), alice, "Version not found"],
    [id, "v".repeat(100), alice, "Version not found"],
    [id, "ver_%00", alice, "Version not found"],
    [id, "v".repeat(101), alice, "Route not found"],
    ["c".repeat(101), v1, alice, "Route not found"],
  ] as const) {
    const response = await read(chapter, version, headers);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message, details: null } });
  }
  expect(readPool.connect).not.toHaveBeenCalled();

  for (const version of ["ver_000000000000", empty.version.id]) {
    const response = await read(id, version);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message: "Version not found", details: null } });
  }

  readPool.connect.mockRejectedValueOnce(new Error("Database connection failed"));
  const failed = await read(id, v1);
  expect(failed.statusCode).toBe(500);
  expect(failed.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
  expect(await state()).toEqual(before);
});
