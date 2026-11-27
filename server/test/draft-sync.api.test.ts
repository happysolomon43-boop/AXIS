import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { BookChapters, ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import type { DraftDetail } from "../src/drafts/repository.js";
import { readChapterSync } from "../src/sync/read.js";
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
  app = buildApp({ pool });
});
afterEach(() => app.close());
afterAll(() => pool.end());

const listPath = () => "/books/" + bookId + "/chapters";
const chapterPath = (id: string, part: string) => "/chapters/" + id + "/" + part;

async function create() {
  const result = await app.inject({ method: "POST", url: listPath(), headers: alice, payload: { content: "abc" } });
  expect(result.statusCode).toBe(201);
  const { chapter, version } = result.json<ChapterCreated>();
  return { id: chapter.id, version: version.id };
}

async function post(id: string, part: string, status: number, payload?: object) {
  const result = await app.inject({ method: "POST", url: chapterPath(id, part), headers: alice, payload });
  expect(result.statusCode).toBe(status);
  return result;
}

async function sent() {
  const { id, version } = await create();
  const result = await post(id, "send", 201, { content: "abc", parent_version: version });
  return { id, version: result.json<VersionWritten>().version.id };
}

async function head({ id, version }: Awaited<ReturnType<typeof sent>>, content: string) {
  const result = await app.inject({
    method: "PUT", url: chapterPath(id, "draft"), headers: alice,
    payload: { content, base_version: version, base_revision: 0 },
  });
  expect(result.statusCode).toBe(200);
}

async function draft(id: string) {
  const result = await app.inject({ method: "GET", url: chapterPath(id, "draft"), headers: alice });
  expect(result.statusCode).toBe(200);
  return result.json<DraftDetail>();
}

async function seedStates() {
  const d1 = await create();
  const d2 = await sent();
  const d3 = await sent();
  await head(d3, "abd");
  const d4 = await sent();
  await head(d4, "  abc \n");
  const d5 = await sent();
  await post(d5.id, "versions", 201, { content: "abd", parent_version: d5.version });
  const d6 = await sent();
  await post(d6.id, "activate", 200, { version_id: null });
  return [d1, d2, d3, d4, d5, d6];
}

test("AXB-0076 AC1 returns only the draft contract keys and computes sync from the appropriate text", async () => {
  const seeded = await seedStates();
  const replies = await Promise.all(seeded.map(({ id }) => draft(id)));
  for (const value of replies) expect(Object.keys(value).sort()).toEqual(["chapter", "draft", "sync"]);
  expect(replies.map(({ sync }) => sync)).toEqual([
    { state: "draft_only", same: false }, { state: "in_book", same: true }, { state: "edited", same: false },
    { state: "in_book", same: true }, { state: "edited", same: false }, { state: "draft_only", same: false },
  ]);
  expect(replies[2]?.draft).toEqual({
    base_version: seeded[2]?.version, content: "abd", revision: 1,
    blocks: [{ ordinal: 1, kind: "paragraph", text: "abd" }],
  });
  expect(replies[4]?.draft).toBeNull();
});

test("AXB-0076 AC2 reports a pull-back mark until the active version changes", async () => {
  const chapter = await sent();
  await post(chapter.id, "pull-back", 200);
  chapter.version=(await pool.query("SELECT id FROM chapter_versions WHERE chapter_id=$1 ORDER BY version_no DESC LIMIT 1",[chapter.id])).rows[0].id;
  expect((await draft(chapter.id)).sync).toEqual({ state: "being_revised", same: true });
  await head(chapter, "abd");
  expect((await draft(chapter.id)).sync).toEqual({ state: "being_revised", same: false });
  await post(chapter.id, "send", 201, { content: "abe", parent_version: chapter.version });
  expect(await draft(chapter.id)).toMatchObject({ draft: null, sync: { state: "in_book", same: true } });
});

test("AXB-0076 AC3 agrees with the chapter list and rejects an unknown chapter", async () => {
  await seedStates();
  for (const content of ["abc", "abd"]) {
    const chapter = await sent();
    await post(chapter.id, "pull-back", 200);
    await head(chapter, content);
  }
  const reply = await app.inject({ method: "GET", url: listPath(), headers: alice });
  expect(reply.statusCode).toBe(200);
  const { chapters } = reply.json<BookChapters>();
  expect(chapters).toHaveLength(8);
  for (const item of chapters) expect((await draft(item.id)).sync).toEqual(item.sync);
  await expect(readChapterSync(pool, "ch_ffffffffffff")).rejects.toThrow("Chapter not found");
});

test("AXB-0076 AC4 keeps the endpoint owner-only and read-only with its existing route limits", async () => {
  const chapter = await sent();
  await head(chapter, "abd");
  await post(chapter.id, "pull-back", 200);
  const countWorkspace = () => pool.query(
    "SELECT (SELECT count(*) FROM chapter_drafts) AS drafts, (SELECT count(*) FROM chapter_pullbacks) AS marks",
  );
  const before = await intakeCounts(pool);
  const workspace = (await countWorkspace()).rows;
  await draft(chapter.id);
  expect(await intakeCounts(pool)).toEqual(before);
  expect((await countWorkspace()).rows).toEqual(workspace);
  for (const [id, headers, status, code, message] of [
    [chapter.id, bob, 404, "not_found", "Chapter not found"],
    [chapter.id, {}, 401, "auth_required", "Missing or invalid X-Axis-User header"],
    ["c".repeat(100), alice, 404, "not_found", "Chapter not found"],
    ["c".repeat(101), alice, 404, "not_found", "Route not found"],
  ] as const) {
    const reply = await app.inject({ method: "GET", url: chapterPath(id, "draft"), headers });
    expect(reply.statusCode).toBe(status);
    expect(reply.json()).toEqual({ error: { code, message, details: null } });
  }
});
