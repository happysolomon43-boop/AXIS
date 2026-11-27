import { Writable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries, seedVersionAs } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
const raw = "# Ash\r\n\r\nLyra  waits.\n";
const later = "# Ash\n\nLyra waits.";
const connect = vi.fn(() => pool.connect());
let app: FastifyInstance;
let chapterId: string, foreignId: string, otherVersion: string;
let bookId: string, seriesId: string, v1: string, v2: string, v3: string;
let logs: string;

function read(chapter: string, version: string, headers: Record<string, string> = alice) {
  return app.inject({ method: "GET", url: `/chapters/${chapter}/versions/${version}/text?ignored=yes`, headers });
}

beforeEach(async () => {
  await resetDb(pool);
  connect.mockReset().mockImplementation(() => pool.connect());
  logs = "";
  app = buildApp({ pool: { query: pool.query.bind(pool), connect } as unknown as Pool }, new Writable({
    write(chunk, _encoding, done) { logs += chunk.toString(); done(); },
  }));
  ({ bookId, seriesId } = await seedSeries(pool));
  const book = { id: bookId, series_id: seriesId };
  const foreign = await seedSeries(pool, "usr_bob");
  const first = await createChapterWithFirstVersion(pool, "usr_alice", book, raw, "draft_edit");
  chapterId = first.chapter.id;
  v1 = first.version.id;
  v2 = await seedVersionAs(pool, seriesId, chapterId, later, "send", "chapter.version.append");
  v3 = await seedVersionAs(pool, seriesId, chapterId, "", "restore", "chapter.restore");
  otherVersion = (await createChapterWithFirstVersion(pool, "usr_alice", book, "Other chapter", "draft_edit")).version.id;
  foreignId = (await createChapterWithFirstVersion(pool, "usr_bob",
    { id: foreign.bookId, series_id: foreign.seriesId }, "Foreign chapter", "draft_edit")).chapter.id;
  const draft = await app.inject({ method: "PUT", url: `/chapters/${chapterId}/draft`, headers: alice,
    payload: { content: "Keep my line.", base_version: v3, base_revision: 0 } });
  expect(draft.statusCode, draft.body).toBe(200);
  connect.mockClear();
  logs = "";
});

afterEach(() => app.close());
afterAll(() => pool.end());

function expectError(reply: Awaited<ReturnType<typeof read>>, status: number, code: string, message: string) {
  expect(reply.statusCode).toBe(status);
  expect(reply.json()).toEqual({ error: { code, message, details: null } });
  expect(reply.headers["cache-control"]).toBe("no-store");
}

test("AC1 retains exact saved source across a new append regardless of the active and working texts", async () => {
  const hashes = await pool.query("SELECT text_hash, hints_hash FROM chapter_versions WHERE id = ANY($1) ORDER BY version_no", [[v1, v2]]);
  expect(hashes.rows[0]).toEqual(hashes.rows[1]);
  const before = await read(chapterId, v1);
  await seedVersionAs(pool, seriesId, chapterId, "New latest", "draft_edit", "chapter.version.append");
  const after = await read(chapterId, v1);
  for (const reply of [before, after]) {
    expect(reply.statusCode).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.json()).toEqual({ chapter_id: chapterId, version_id: v1, content: raw });
  }
  expect(connect).toHaveBeenCalledTimes(2);
});

test("AC2 scopes chapter ownership first and version identity second", async () => {
  expectError(await read(chapterId, v1, bob), 404, "not_found", "Chapter not found");
  expectError(await read(foreignId, "a".repeat(65)), 404, "not_found", "Chapter not found");
  expectError(await read(chapterId, otherVersion), 404, "not_found", "Version not found");
  expectError(await read(chapterId, "ver_000000000000"), 404, "not_found", "Version not found");
});

test("AC3 preserves routing, validation, rollback and safe logging", async () => {
  expectError(await read("a".repeat(101), v1, {}), 401, "auth_required", "Missing or invalid X-Axis-User header");
  expectError(await read(chapterId, v1, { "x-axis-user": "bad" }), 401, "auth_required", "Missing or invalid X-Axis-User header");
  expectError(await read("a".repeat(101), v1), 404, "not_found", "Route not found");
  expectError(await read(chapterId, "a".repeat(101)), 404, "not_found", "Route not found");
  expectError(await read("a".repeat(65), v1), 404, "not_found", "Chapter not found");
  expectError(await read(chapterId, encodeURIComponent("📚".repeat(65))), 404, "not_found", "Version not found");
  expectError(await read("%00", v1), 404, "not_found", "Chapter not found");
  expectError(await read(chapterId, "%00"), 404, "not_found", "Version not found");

  const invalidEncoding = await read(chapterId, "%ZZ");
  expect(invalidEncoding.statusCode).toBe(400);
  expect(invalidEncoding.json()).toEqual({
    error: { code: "validation_failed", message: "Request could not be parsed", details: null },
  });

  const client = await pool.connect();
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes("SELECT chapter_id, id AS version_id")) throw new Error(`Private failure: ${raw} ${chapterId} ${v1}`);
    return client.query(sql, args);
  });
  const release = vi.fn((discard: boolean) => client.release(discard));
  connect.mockResolvedValueOnce({ query, release } as unknown as PoolClient);
  expectError(await read(chapterId, v1), 500, "internal", "Internal error");
  expect(query.mock.calls.map(([sql]) => sql)).toEqual([
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    expect.stringContaining("s.owner_id = $2"),
    expect.stringContaining("chapter_id = $1 AND id = $2"),
    "ROLLBACK",
  ]);
  expect(release.mock.calls).toEqual([[false]]);
  expect((await read(chapterId, v1)).statusCode).toBe(200);
  expect(logs).toContain('"/chapters/:id/versions/:versionId/text"');
  expect(logs).toContain('"event":"request_failed"');
  for (const secret of [chapterId, foreignId, v1, v2, v3, otherVersion, "Lyra", "Private failure", "Keep my line."]) {
    expect(logs).not.toContain(secret);
  }
});

test("AC4 a released book's empty source leaves manuscript, ledger and receipt rows unchanged", async () => {
  await pool.query("UPDATE books SET status = 'released' WHERE id = $1", [bookId]);
  const tables = ["series", "books", "chapters", "chapter_versions", "chapter_active", "blocks", "scenes",
    "ledger", "chapter_drafts", "chapter_pullbacks", "chapter_write_receipts", "snapshot_capture_requests",
    "named_cuts", "snapshot_label_lifecycles"];
  const snapshot = () => Promise.all(tables.map(async table =>
    (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)`)).rows));
  const before = await snapshot();
  const reply = await read(chapterId, v3);
  expect(reply.statusCode, reply.body).toBe(200);
  expect(reply.headers["cache-control"]).toBe("no-store");
  expect(reply.json()).toEqual({ chapter_id: chapterId, version_id: v3, content: "" });
  expect(await snapshot()).toEqual(before);
});
