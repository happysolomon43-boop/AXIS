import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated, ChapterDetail } from "../src/corpus/repo.js";
import type { SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { abcHash, emptyHash, helloHash, intakeCounts, story, storyBlocks, storyScenes } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const json = { ...alice, "content-type": "application/json" };
const hash = /^[0-9a-f]{64}$/;
const uid = /^b_[0-9a-f]{12}$/;
let app: FastifyInstance;
let seriesId: string;
let bookId: string;

beforeEach(async () => {
  await resetDb(pool);
  app = buildApp({ pool });
  const response = await app.inject({
    method: "POST", url: "/series", headers: json, payload: { title: "Ashfall" },
  });
  expect(response.statusCode).toBe(201);
  const { series, books } = response.json<SeriesTree>();
  seriesId = series.id;
  bookId = books[0]!.id;
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

async function read(chapterId: string) {
  const response = await app.inject({ method: "GET", url: `/chapters/${chapterId}`, headers: alice });
  expect(response.statusCode).toBe(200);
  return response.json<ChapterDetail>();
}

async function commit(rows: object[], op: string) {
  const { rows: [row] } = await pool.query<{ result: { ids: string[]; l_seq: number } }>(
    "SELECT commit_inputs($1, 'corpus', 'usr_alice', $2, $3::jsonb) AS result",
    [seriesId, op, JSON.stringify(rows)],
  );
  if (!row) throw new Error("Commit returned no result");
  return row.result;
}

test("AC1 reads the latest version and ordered intake independently of activation", async () => {
  const created = await create(story);
  const detail = await read(created.chapter.id);
  expect(detail).toEqual({
    chapter: created.chapter,
    version: { ...created.version, content: story, version_no: 1, hints_hash: emptyHash },
    active_version_id: null,
    blocks: storyBlocks.map(({ ordinal, kind, text }) => ({
      ordinal, kind, text, hash: expect.stringMatching(hash), block_uid: expect.stringMatching(uid),
    })),
    scenes: storyScenes.map((scene) => ({
      ...scene, fingerprint: expect.stringMatching(hash), pov_hint: null, location_hint: null,
      time_hint: null, time_mode: "linear",
    })),
  });

  const abc = await create("abc");
  const abcDetail = await read(abc.chapter.id);
  expect(abcDetail.blocks.map(({ hash }) => hash)).toEqual([abcHash]);
  expect(abcDetail.scenes.map(({ fingerprint }) => fingerprint)).toEqual([abcHash]);

  const chapterId = abc.chapter.id;
  const v1 = abc.version.id;
  const { ids: [v2], l_seq } = await commit([
    { kind: "chapter_version", chapter_id: chapterId, content: "hello", source: "draft_edit" },
  ], "version.add");
  const activate = (versionId: string | null) => commit([
    { kind: "chapter_active", chapter_id: chapterId, version_id: versionId },
  ], "chapter.send");

  await activate(v1);
  const withFirstActive = await read(chapterId);
  expect(withFirstActive.version).toMatchObject({
    id: v2, version_no: 2, parent_version: v1, content: "hello", text_hash: helloHash, l_seq,
  });
  expect(withFirstActive.blocks.map(({ hash }) => hash)).toEqual([helloHash]);
  expect(withFirstActive.scenes.map(({ fingerprint }) => fingerprint)).toEqual([helloHash]);
  expect(withFirstActive.active_version_id).toBe(v1);

  await activate(v2!);
  expect((await read(chapterId)).active_version_id).toBe(v2);
  await activate(null);
  expect((await read(chapterId)).active_version_id).toBeNull();

  const chapterOnly = await commit([{ kind: "chapter", book_id: bookId }], "chapter.create");
  expect(await read(chapterOnly.ids[0]!)).toEqual({
    chapter: { id: chapterOnly.ids[0], book_id: bookId, order_key: "0000003000" },
    version: null, active_version_id: null, blocks: [], scenes: [],
  });

  const empty = await create("");
  const emptyDetail = await read(empty.chapter.id);
  expect(emptyDetail.version?.content).toBe("");
  expect(emptyDetail.blocks).toEqual([]);
  expect(emptyDetail.scenes).toEqual([]);
});

test("AC2 enforces identity and ID boundaries and leaves all six tables unchanged", async () => {
  const { chapter } = await create(story);
  const before = await intakeCounts(pool);
  const notFound = {
    error: { code: "not_found", message: "Chapter not found", details: null },
  };
  const authRequired = {
    error: { code: "auth_required", message: "Missing or invalid X-Axis-User header", details: null },
  };
  const request = (id: string, headers?: Record<string, string>) =>
    app.inject({ method: "GET", url: `/chapters/${id}`, headers });

  for (const headers of [undefined, { "x-axis-user": "usr_Alice" }]) {
    const response = await request(chapter.id, headers);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(authRequired);
    expect(await intakeCounts(pool)).toEqual(before);
  }
  const denied = await request(chapter.id, { "x-axis-user": "usr_bob" });
  expect(denied.statusCode).toBe(404);
  expect(denied.json()).toEqual(notFound);
  expect(await intakeCounts(pool)).toEqual(before);

  for (const id of ["ch_000000000000", "not-an-id", "%00", "a".repeat(65), "a".repeat(100)]) {
    const response = await request(id, alice);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(notFound);
    expect(await intakeCounts(pool)).toEqual(before);
  }
  const tooLong = await request("a".repeat(101), alice);
  expect(tooLong.statusCode).toBe(404);
  expect(tooLong.json()).toEqual({
    error: { code: "not_found", message: "Route not found", details: null },
  });
  expect(await intakeCounts(pool)).toEqual(before);
  await read(chapter.id);
  expect(await intakeCounts(pool)).toEqual(before);

  let dbCalls = 0;
  const unreachable = {
    async connect() {
      dbCalls += 1;
      throw new Error("database unavailable");
    },
  } as unknown as Pool;
  const errorApp = buildApp({ pool: unreachable });
  try {
    for (const id of ["%00", "a".repeat(65)]) {
      const malformed = await errorApp.inject({ method: "GET", url: `/chapters/${id}`, headers: alice });
      expect(malformed.statusCode).toBe(404);
      expect(malformed.json()).toEqual(notFound);
    }
    expect(dbCalls).toBe(0);
    const failure = await errorApp.inject({ method: "GET", url: `/chapters/${chapter.id}`, headers: alice });
    expect(failure.statusCode).toBe(500);
    expect(failure.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
    expect(dbCalls).toBe(1);
  } finally {
    await errorApp.close();
  }
});
