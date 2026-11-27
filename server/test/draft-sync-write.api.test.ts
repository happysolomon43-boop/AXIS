import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import type { VersionSaved } from "../src/corpus/routes.js";
import type { DraftDetail, DraftWritten } from "../src/drafts/repository.js";
import * as syncReader from "../src/sync/read.js";
import { makePool, resetDb } from "./helpers.js";
import { intakeCounts, seedSeries } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
const draftOnly = { state: "draft_only", same: false };
const inBook = { state: "in_book", same: true };
const edited = { state: "edited", same: false };
const revised = { state: "being_revised", same: false };
let app: FastifyInstance;
let bookId: string;

beforeEach(async () => {
  await resetDb(pool);
  ({ bookId } = await seedSeries(pool));
  app = buildApp({ pool });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});
afterAll(() => pool.end());

const path = (id: string, part: string) => "/chapters/" + id + "/" + part;

async function create() {
  const reply = await app.inject({
    method: "POST", url: "/books/" + bookId + "/chapters", headers: alice, payload: { content: "abc" },
  });
  expect(reply.statusCode).toBe(201);
  const { chapter, version } = reply.json<ChapterCreated>();
  return { id: chapter.id, version: version.id };
}

function write(id: string, action: "send" | "versions", content: string, parent_version: string, headers: Record<string, string> = alice) {
  return app.inject({ method: "POST", url: path(id, action), headers, payload: { content, parent_version } });
}

async function sent() {
  const { id, version } = await create();
  const reply = await write(id, "send", "abc", version);
  expect(reply.statusCode).toBe(201);
  return { id, version: reply.json<VersionWritten>().version.id };
}

async function mark(id: string) {
  const reply = await app.inject({ method: "POST", url: path(id, "pull-back"), headers: alice });
  expect(reply.statusCode).toBe(200);
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM chapter_versions WHERE chapter_id = $1 ORDER BY version_no DESC LIMIT 1", [id]);
  return rows[0]!.id;
}

function put(id: string, content: string, base_version: string, base_revision: number, headers: Record<string, string> = alice) {
  return app.inject({ method: "PUT", url: path(id, "draft"), headers, payload: { content, base_version, base_revision } });
}

async function draft(id: string) {
  const reply = await app.inject({ method: "GET", url: path(id, "draft"), headers: alice });
  expect(reply.statusCode).toBe(200);
  return reply.json<DraftDetail>();
}

test("AXB-0077 AC1 PUT serves the hash-based sync state in the write response", async () => {
  const { id, version } = await sent();
  const first = await put(id, "abd", version, 0);
  expect(first.statusCode).toBe(200);
  const value = first.json<DraftWritten>();
  expect(Object.keys(value).sort()).toEqual(["base_version", "chapter", "revision", "sync"]);
  expect(value.sync).toEqual(edited);

  const folded = await put(id, "  abc \n", version, 1);
  expect(folded.statusCode).toBe(200);
  expect(folded.json<DraftWritten>().sync).toEqual(inBook);
  const refused = await app.inject({ method: "POST", url: path(id, "pull-back"), headers: alice });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.details.reason).toBe("base_choice_required");
  expect((await put(id, "abc", version, 2)).statusCode).toBe(200);
  const inert = await mark(id);
  const pulled = await put(id, "abd", inert, 0);
  expect(pulled.statusCode).toBe(200);
  expect(pulled.json<DraftWritten>().sync).toEqual(revised);

  const unsent = await create();
  const written = await put(unsent.id, "abd", unsent.version, 0);
  expect(written.statusCode).toBe(200);
  expect(written.json<DraftWritten>().sync).toEqual(draftOnly);
});

test("AXB-0077 AC2 PUT replies agree with GET and conflicts keep the existing envelope", async () => {
  const { id, version } = await sent();
  const written = await put(id, "abd", version, 0);
  expect(written.statusCode).toBe(200);
  expect(written.json<DraftWritten>().sync).toEqual((await draft(id)).sync);
  for (const [baseVersion, baseRevision, reason] of [
    ["ver_ffffffffffff", 0, "version"], [version, 0, "revision"],
  ] as const) {
    const conflict = await put(id, "abe", baseVersion, baseRevision);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: {
      code: "conflict", message: "Draft is out of date",
      details: { reason, current_version: version, current_revision: 1 },
    } });
  }
  const folded = await put(id, " abc ", version, 1);
  expect(folded.statusCode).toBe(200);
  expect(folded.json<DraftWritten>().sync).toEqual((await draft(id)).sync);
});

test("AXB-0077 AC3 only Save adds sync to its version response", async () => {
  const { id, version } = await sent();
  const save = async (chapterId: string, parent: string, content: string, sync: object) => {
    const reply = await write(chapterId, "versions", content, parent);
    expect(reply.statusCode).toBe(201);
    const value = reply.json<VersionSaved>();
    expect(Object.keys(value).sort()).toEqual(["active_version_id", "chapter", "sync", "version"]);
    expect(value.sync).toEqual(sync);
    return value;
  };
  const changed = await save(id, version, "abd", edited);
  expect(changed.active_version_id).toBe(version);
  await save(id, changed.version.id, "abc", inBook);
  const inert = await mark(id);
  const pulled = await save(id, inert, "abd", revised);
  const sentAgain = await write(id, "send", "abd", pulled.version.id);
  expect(sentAgain.statusCode).toBe(201);
  expect(Object.keys(sentAgain.json()).sort()).toEqual(["active_version_id", "chapter", "version"]);

  const unsent = await create();
  await save(unsent.id, unsent.version, "abd", draftOnly);
});

test("AXB-0077 AC4 preserves write boundaries, auth and rollback semantics", async () => {
  const { id, version } = await sent();
  const before = await intakeCounts(pool);
  const internal = { error: { code: "internal", message: "Internal error", details: null } };
  const read = vi.spyOn(syncReader, "readChapterSync");
  read.mockRejectedValueOnce(new Error("sync read failed inside PUT"));
  const rolledBack = await put(id, "abd", version, 0);
  expect(rolledBack.statusCode).toBe(500);
  expect(rolledBack.json()).toEqual(internal);
  expect((await draft(id)).draft).toBeNull();

  expect((await put(id, "abd", version, 0)).statusCode).toBe(200);
  expect(await intakeCounts(pool)).toEqual(before);
  read.mockRejectedValueOnce(new Error("sync read failed after Save"));
  const committed = await write(id, "versions", "abe", version);
  expect(committed.statusCode).toBe(500);
  expect(committed.json()).toEqual(internal);
  expect((await draft(id)).draft).toBeNull();
  expect((await intakeCounts(pool))?.ledger).toBe(before!.ledger + 1);
  const { rows } = await pool.query("SELECT op FROM ledger ORDER BY l_seq DESC LIMIT 1");
  expect(rows).toEqual([{ op: "chapter.version.append" }]);

  for (const [headers, status, error] of [
    [bob, 404, { code: "not_found", message: "Chapter not found", details: null }],
    [{}, 401, { code: "auth_required", message: "Missing or invalid X-Axis-User header", details: null }],
  ] as const) {
    for (const reply of [await put(id, "abc", version, 0, headers), await write(id, "versions", "abc", version, headers)]) {
      expect(reply.statusCode).toBe(status);
      expect(reply.json()).toEqual({ error });
    }
  }
});
