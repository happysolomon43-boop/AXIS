import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { BookChapters, ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import { computeSync } from "../src/sync/state.js";
import { makePool, resetDb } from "./helpers.js";
import { intakeCounts, seedSeries } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
let app: FastifyInstance;
let bookId: string;

beforeEach(async () => {
  await resetDb(pool);
  ({ bookId } = await seedSeries(pool));
  await seedSeries(pool, "usr_bob");
  app = buildApp({ pool });
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await pool.end();
});

const chapterPath = (id: string) => `/chapters/${id}`;
const listPath = () => `/books/${bookId}/chapters`;

async function create() {
  const reply = await app.inject({ method: "POST", url: listPath(), headers: alice, payload: { content: "abc" } });
  expect(reply.statusCode).toBe(201);
  return reply.json<ChapterCreated>();
}

async function write(id: string, action: "send" | "versions", content: string, parent_version: string) {
  const reply = await app.inject({
    method: "POST", url: `${chapterPath(id)}/${action}`, headers: alice, payload: { content, parent_version },
  });
  expect(reply.statusCode).toBe(201);
  return reply.json<VersionWritten>();
}

async function putHead(id: string, base_version: string, content: string) {
  const reply = await app.inject({
    method: "PUT", url: `${chapterPath(id)}/draft`, headers: alice, payload: { content, base_version, base_revision: 0 },
  });
  expect(reply.statusCode).toBe(200);
}

async function activate(id: string, version_id: string | null) {
  const reply = await app.inject({
    method: "POST", url: `${chapterPath(id)}/activate`, headers: alice, payload: { version_id },
  });
  expect(reply.statusCode).toBe(200);
}

async function pullBack(id: string) {
  const reply = await app.inject({ method: "POST", url: `${chapterPath(id)}/pull-back`, headers: alice });
  expect(reply.statusCode).toBe(200);
}

async function chapters() {
  const reply = await app.inject({ method: "GET", url: listPath(), headers: alice });
  expect(reply.statusCode).toBe(200);
  return reply.json<BookChapters>().chapters;
}

async function sentChapter() {
  const first = await create();
  const id = first.chapter.id;
  return { id, first, sent: await write(id, "send", "abc", first.version.id) };
}

async function populate() {
  const c1 = await create();
  const c2 = await sentChapter();
  const c3 = await sentChapter();
  const v3 = await write(c3.id, "versions", "abd", c3.sent.version.id);
  const c4 = await sentChapter();
  const v4 = await write(c4.id, "versions", "abc", c4.sent.version.id);
  const c5 = await sentChapter();
  await putHead(c5.id, c5.sent.version.id, "abd");
  const c6 = await sentChapter();
  await putHead(c6.id, c6.sent.version.id, "  abc \n");
  const c7 = await sentChapter();
  await activate(c7.id, null);
  return { c1, c2, c3, c4, c5, c6, c7, v3, v4 };
}

test("AC1 serves sync from the head hash or displayed-version hash and preserves list metadata", async () => {
  const { c1, c2, c3, c4, c5, c6, c7, v3, v4 } = await populate();
  expect(await chapters()).toEqual([
    { ...c1.chapter, title: null, word_count: 1, version_id: c1.version.id, active_version_id: null,
      sync: { state: "draft_only", same: false } },
    { ...c2.sent.chapter, title: null, word_count: 1, version_id: c2.sent.version.id, active_version_id: c2.sent.version.id,
      sync: { state: "in_book", same: true } },
    { ...c3.sent.chapter, title: null, word_count: 1, version_id: v3.version.id, active_version_id: c3.sent.version.id,
      sync: { state: "edited", same: false } },
    { ...c4.sent.chapter, title: null, word_count: 1, version_id: v4.version.id, active_version_id: c4.sent.version.id,
      sync: { state: "in_book", same: true } },
    { ...c5.sent.chapter, title: null, word_count: 1, version_id: c5.sent.version.id, active_version_id: c5.sent.version.id,
      sync: { state: "edited", same: false } },
    { ...c6.sent.chapter, title: null, word_count: 1, version_id: c6.sent.version.id, active_version_id: c6.sent.version.id,
      sync: { state: "in_book", same: true } },
    { ...c7.sent.chapter, title: null, word_count: 1, version_id: c7.sent.version.id, active_version_id: null,
      sync: { state: "draft_only", same: false } },
  ]);
  expect(v4.version.id).not.toBe(c4.sent.version.id);
  expect(v4.version.text_hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("AC2 tracks the pull-back mark through edits, saves, sends and activation", async () => {
  const { id, first, sent } = await sentChapter();
  const sync = async () => (await chapters())[0]?.sync;
  await pullBack(id);
  expect(await sync()).toEqual({ state: "being_revised", same: true });
  await putHead(id, sent.version.id, "abd");
  expect(await sync()).toEqual({ state: "being_revised", same: false });
  const saved = await write(id, "versions", "abd", sent.version.id);
  expect(await sync()).toEqual({ state: "being_revised", same: false });

  const next = await write(id, "send", "abe", saved.version.id);
  expect(await sync()).toEqual({ state: "in_book", same: true });
  expect((await pool.query("SELECT 1 FROM chapter_drafts WHERE chapter_id = $1", [id])).rows).toEqual([]);
  await pullBack(id);
  expect(await sync()).toEqual({ state: "being_revised", same: true });
  await activate(id, first.version.id);
  expect(await sync()).toEqual({ state: "edited", same: false });
  await activate(id, null);
  expect(await sync()).toEqual({ state: "draft_only", same: false });
  await activate(id, next.version.id);
  expect(await sync()).toEqual({ state: "being_revised", same: true });
});

test("AC3 computes all eight sync cases from its argument", () => {
  const cases = [
    [null, null, "h1", null, "draft_only", false],
    [null, null, "h1", "v1", "draft_only", false],
    ["v1", "h1", "h1", null, "in_book", true],
    ["v1", "h1", "h2", null, "edited", false],
    ["v1", "h1", "h1", "v1", "being_revised", true],
    ["v1", "h1", "h2", "v1", "being_revised", false],
    ["v2", "h1", "h1", "v1", "in_book", true],
    ["v1", "h1", null, null, "edited", false],
  ] as const;
  for (const [activeVersionId, activeTextHash, draftTextHash, pulledFrom, state, same] of cases) {
    expect(computeSync({ activeVersionId, activeTextHash, draftTextHash, pulledFrom })).toEqual({ state, same });
  }
});

test("AC4 keeps the chapter list read-only, owner-only and bytewise ordered", async () => {
  const { c1, c2, c3, c4, c5, c6, c7 } = await populate();
  await pullBack(c2.id);
  await pool.query("UPDATE chapters SET order_key = $1 WHERE id = $2", [c1.chapter.order_key, c2.id]);
  const workspace = async () => (await pool.query(
    "SELECT (SELECT count(*) FROM chapter_drafts) AS heads, (SELECT count(*) FROM chapter_pullbacks) AS marks",
  )).rows;
  const before = await intakeCounts(pool);
  const beforeWorkspace = await workspace();
  expect((await chapters()).map(({ id }) => id)).toEqual([
    ...[c1.chapter.id, c2.id].sort(), c3.id, c4.id, c5.id, c6.id, c7.id,
  ]);
  const denied = await app.inject({ method: "GET", url: listPath(), headers: bob });
  expect(denied.statusCode).toBe(404);
  expect(denied.json()).toEqual({ error: { code: "not_found", message: "Book not found", details: null } });
  const anonymous = await app.inject({ method: "GET", url: listPath() });
  expect(anonymous.statusCode).toBe(401);
  expect(anonymous.json().error.code).toBe("auth_required");
  expect(await intakeCounts(pool)).toEqual(before);
  expect(await workspace()).toEqual(beforeWorkspace);
});
