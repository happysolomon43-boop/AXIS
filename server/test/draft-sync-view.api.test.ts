import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { BookChapters, ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries } from "./seed.js";

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
const list = () => "/books/" + bookId + "/chapters";
const path = (id: string) => "/chapters/" + id + "/draft";
async function create(sent = false) {
  const created = await app.inject({ method: "POST", url: list(), headers: alice, payload: { content: "abc" } });
  expect(created.statusCode).toBe(201);
  const { chapter, version } = created.json<ChapterCreated>();
  if (!sent) return { id: chapter.id, version: version.id };
  const result = await app.inject({ method: "POST", url: "/chapters/" + chapter.id + "/send", headers: alice,
    payload: { content: "abc", parent_version: version.id } });
  expect(result.statusCode).toBe(201);
  return { id: chapter.id, version: result.json<VersionWritten>().version.id };
}
async function edit(chapter: Awaited<ReturnType<typeof create>>) {
  const result = await app.inject({ method: "PUT", url: path(chapter.id), headers: alice,
    payload: { content: "abd", base_version: chapter.version, base_revision: 0 } });
  expect(result.statusCode).toBe(200);
}
async function pull(id: string) {
  expect((await app.inject({ method: "POST", url: "/chapters/" + id + "/pull-back", headers: alice })).statusCode).toBe(200);
}
async function projection(id: string) {
  const response = await app.inject({ method: "GET", url: path(id) + "?view=sync", headers: alice });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = response.json();
  expect(Object.keys(body)).toEqual(["sync"]);
  expect(Object.keys(body.sync).sort()).toEqual(["same", "state"]);
  return body.sync;
}
test("AXB-0083 AC1 exact projection pairs and agreement", async () => {
  const only = await create(), current = await create(true), edited = await create(true), revised = await create(true);
  await edit(edited);
  await pull(revised.id);
  expect(await projection(only.id)).toEqual({ state: "draft_only", same: false });
  expect(await projection(current.id)).toEqual({ state: "in_book", same: true });
  expect(await projection(edited.id)).toEqual({ state: "edited", same: false });
  expect(await projection(revised.id)).toEqual({ state: "being_revised", same: true });
  const newest=(await pool.query("SELECT id FROM chapter_versions WHERE chapter_id=$1 ORDER BY version_no DESC LIMIT 1",[revised.id])).rows[0].id;
  await edit({...revised,version:newest});
  const sync = await projection(revised.id);
  expect(sync).toEqual({ state: "being_revised", same: false });
  const rows = (await app.inject({ method: "GET", url: list(), headers: alice })).json<BookChapters>().chapters;
  expect(rows.find(row => row.id === revised.id)?.sync).toEqual(sync);
  expect((await app.inject({ method: "GET", url: path(revised.id), headers: alice })).json().sync).toEqual(sync);
});
test("AXB-0083 AC2 selector preserves ordinary read", async () => {
  const chapter = await create(true);
  await edit(chapter);
  for (const suffix of ["", "?view=full", "?view=", "?view=sync&view=sync", "?view=full&view=sync", "?view=sync&view=full"]) {
    const response = await app.inject({ method: "GET", url: path(chapter.id) + suffix, headers: alice });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["chapter", "draft", "sync"]);
    expect(body.draft).toEqual({ base_version: chapter.version, revision: 1, content: "abd",
      blocks: [{ ordinal: 1, kind: "paragraph", text: "abd" }] });
  }
  for (const suffix of ["?unused=1&view=sync", "?v%69ew=s%79nc&unused=2"]) {
    const response = await app.inject({ method: "GET", url: path(chapter.id) + suffix, headers: alice });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sync: { state: "edited", same: false } });
  }
});
test("AXB-0083 AC3 ownership and route guards", async () => {
  const chapter = await create();
  for (const suffix of ["", "?view=sync"]) {
    for (const [id, headers, status, code, message] of [
      [chapter.id, bob, 404, "not_found", "Chapter not found"],
      [chapter.id, {}, 401, "auth_required", "Missing or invalid X-Axis-User header"],
      [chapter.id, { "x-axis-user": "invalid" }, 401, "auth_required", "Missing or invalid X-Axis-User header"],
      ["ch_ffffffffffff", alice, 404, "not_found", "Chapter not found"],
      ["c".repeat(101), alice, 404, "not_found", "Route not found"],
    ] as const) {
      const response = await app.inject({ method: "GET", url: path(id) + suffix, headers });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { code, message, details: null } });
    }
  }
});
test("AXB-0083 AC4 read-only, one sync query, no segmentation, normal database failure", async () => {
  const chapter = await create(true);
  await edit(chapter);
  const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM ledger) AS ledger, (SELECT count(*) FROM chapter_versions) AS versions, (SELECT count(*) FROM chapter_active) AS active, (SELECT count(*) FROM chapter_drafts) AS drafts, (SELECT count(*) FROM chapter_pullbacks) AS marks")).rows;
  const before = await counts();
  const original = pool.query.bind(pool);
  const spy = vi.spyOn(pool, "query");
  try {
    expect(await projection(chapter.id)).toEqual({ state: "edited", same: false });
    const sql = spy.mock.calls.map(args => String(args[0]));
    expect(sql.filter(s => s.includes("latest_text_hash"))).toHaveLength(1);
    expect(sql.filter(s => s.includes("axis_segment"))).toHaveLength(0);
    expect(sql).toHaveLength(2);
    expect(sql[0]).not.toContain("latest_text_hash");
    expect(sql[1]).toContain("latest_text_hash");
    spy.mockImplementation(((...args: unknown[]) => {
      if (String(args[0]).includes("latest_text_hash")) return Promise.reject(new Error("controlled projection failure"));
      return Reflect.apply(original, pool, args);
    }) as typeof pool.query);
    const response = await app.inject({ method: "GET", url: path(chapter.id) + "?view=sync", headers: alice });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
  } finally {
    spy.mockRestore();
  }
  expect(await counts()).toEqual(before);
});
