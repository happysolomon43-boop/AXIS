import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import { runMigrations } from "../src/db/migrate.js";
import type { PullBackWritten } from "../src/pullback/pullback.js";
import { makePool, resetDb } from "./helpers.js";
import { intakeCounts, seedSeries } from "./seed.js";

const pool = makePool();
const apiPool = {
  query: vi.fn(pool.query.bind(pool)),
  connect: vi.fn(() => pool.connect()),
};
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
const migration = "0011_chapter_pullbacks.sql";
const migrationDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
let app: FastifyInstance;
let bookId: string;

beforeEach(async () => {
  await resetDb(pool);
  ({ bookId } = await seedSeries(pool));
  await seedSeries(pool, "usr_bob");
  vi.clearAllMocks();
  app = buildApp({ pool: apiPool as unknown as Pool });
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await pool.end();
});

async function create() {
  const reply = await app.inject({ method: "POST", url: `/books/${bookId}/chapters`, headers: alice, payload: { content: "abc" } });
  expect(reply.statusCode).toBe(201);
  return reply.json<ChapterCreated>();
}

async function send(id: string, content: string, parent_version: string) {
  const reply = await app.inject({ method: "POST", url: `/chapters/${id}/send`, headers: alice, payload: { content, parent_version } });
  expect(reply.statusCode).toBe(201);
  return reply.json<VersionWritten>();
}

async function sentChapter() {
  const first = await create();
  const sent = await send(first.chapter.id, "abc", first.version.id);
  return { ...sent, id: first.chapter.id };
}

function pullBack(id: string, headers: Record<string, string> = alice) {
  return app.inject({ method: "POST", url: `/chapters/${id}/pull-back`, headers });
}

async function marks() {
  return (await pool.query("SELECT chapter_id, book_version FROM chapter_pullbacks")).rows;
}

async function headCount() {
  return (await pool.query("SELECT count(*)::int AS count FROM chapter_drafts")).rows;
}

function errorEnvelope(code: string, message: string) {
  return { error: { code, message, details: null } };
}

test("AC1 applies, rolls back and reapplies migration 0011 and constrains the marked version", async () => {
  const down = await readFile(new URL("../db/rollback/0011_chapter_pullbacks.down.sql", import.meta.url), "utf8");
  const migrationRows = () => pool.query("SELECT filename FROM schema_migrations");
  const table = () => pool.query("SELECT to_regclass('chapter_pullbacks')::text AS name");
  const { rows: columns } = await pool.query(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'chapter_pullbacks' ORDER BY ordinal_position`,
  );
  expect(columns).toEqual([
    { column_name: "chapter_id", is_nullable: "NO", data_type: "text" },
    { column_name: "book_version", is_nullable: "NO", data_type: "text" },
  ]);
  const { rows: [key] } = await pool.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'chapter_pullbacks'::regclass AND contype = 'p'",
  );
  expect(key).toEqual({ definition: "PRIMARY KEY (chapter_id)" });
  expect((await migrationRows()).rows).toHaveLength(15);
  const first = await create();
  const second = await create();
  await pool.query("INSERT INTO chapter_pullbacks VALUES ($1, $2)", [first.chapter.id, first.version.id]);

  await pool.query(down);
  try {
    expect((await table()).rows).toEqual([{ name: null }]);
    const { rows } = await migrationRows();
    expect(rows).toHaveLength(14);
    expect(rows).not.toContainEqual({ filename: migration });
    await expect(runMigrations(pool, migrationDir)).resolves.toEqual([migration]);
    expect((await table()).rows).toEqual([{ name: "chapter_pullbacks" }]);
    expect((await migrationRows()).rows).toHaveLength(15);
    expect(await marks()).toEqual([]);
    await expect(pool.query("INSERT INTO chapter_pullbacks VALUES ($1, $2)", [first.chapter.id, second.version.id]))
      .rejects.toMatchObject({ code: "23503" });
  } finally {
    await runMigrations(pool, migrationDir);
  }
});

test("AC2 marks only the active version and is idempotent until the next send", async () => {
  const { id, chapter, version } = await sentChapter();
  const before = await intakeCounts(pool);
  const heads = await headCount();
  const expected = { chapter, active_version_id: version.id };
  const first = await pullBack(id);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual(expected);
  expect(await marks()).toEqual([{ chapter_id: id, book_version: version.id }]);
  expect(await intakeCounts(pool)).toEqual(before);
  expect(await headCount()).toEqual(heads);

  const repeat = await pullBack(id);
  expect(repeat.statusCode).toBe(200);
  expect(repeat.json()).toEqual(expected);
  expect(await marks()).toEqual([{ chapter_id: id, book_version: version.id }]);
  expect(await intakeCounts(pool)).toEqual(before);
  expect(await headCount()).toEqual(heads);

  const next = await send(id, "abd", version.id);
  const third = await pullBack(id);
  expect(third.statusCode).toBe(200);
  expect(third.json()).toEqual({ chapter, active_version_id: next.version.id });
  expect(await marks()).toEqual([{ chapter_id: id, book_version: next.version.id }]);
});

test("AC3 checks identity, malformed IDs, ownership and whether the chapter is in the Book", async () => {
  const { id } = await sentChapter();
  const { chapter: neverSent } = await create();
  const chapterNotFound = errorEnvelope("not_found", "Chapter not found");
  const notInBook = errorEnvelope("not_in_book", "Chapter has no Book version");
  const auth = await pullBack(id, {});
  expect(auth.statusCode).toBe(401);
  expect(auth.json().error.code).toBe("auth_required");

  for (const reply of [await pullBack(id, bob), await pullBack("ch_missing")]) {
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toEqual(chapterNotFound);
  }
  const unsent = await pullBack(neverSent.id);
  expect(unsent.statusCode).toBe(409);
  expect(unsent.json()).toEqual(notInBook);

  const inactive = await app.inject({
    method: "POST", url: `/chapters/${id}/activate`, headers: alice, payload: { version_id: null },
  });
  expect(inactive.statusCode).toBe(200);
  const rejected = await pullBack(id);
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json()).toEqual(notInBook);
  expect(await marks()).toEqual([]);

  vi.clearAllMocks();
  const tooLong = await pullBack("a".repeat(101));
  expect(tooLong.statusCode).toBe(404);
  expect(tooLong.json()).toEqual(errorEnvelope("not_found", "Route not found"));
  for (const malformed of ["a".repeat(70), "ch_%00"]) {
    const reply = await pullBack(malformed);
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toEqual(chapterNotFound);
  }
  expect(apiPool.query).not.toHaveBeenCalled();
  expect(apiPool.connect).not.toHaveBeenCalled();
});

test("AC4 preserves a draft head, rolls back database errors and serialises with sends", async () => {
  const { id, version } = await sentChapter();
  const url = `/chapters/${id}/draft`;
  const put = await app.inject({
    method: "PUT", url, headers: alice, payload: { content: "abd", base_version: version.id, base_revision: 0 },
  });
  expect(put.statusCode).toBe(200);
  const readDraft = () => app.inject({ method: "GET", url, headers: alice });
  const head = async () => (await pool.query("SELECT * FROM chapter_drafts WHERE chapter_id = $1", [id])).rows;
  const before = await readDraft();
  const beforeRows = await head();
  expect(beforeRows).toEqual([{ chapter_id: id, base_version: version.id, content: "abd", revision: 1 }]);
  expect(before.statusCode).toBe(200);

  // Fail after the upsert, on the chapter-row read, using a single checked-out client.
  const failing = await pool.connect();
  const query = failing.query;
  const runQuery = query.bind(failing);
  const failure = vi.spyOn(failing, "query").mockImplementation(((sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT id, book_id, order_key FROM chapters")) return Promise.reject(new Error("chapter read failed"));
    return runQuery(sql, values);
  }) as typeof query);
  apiPool.connect.mockResolvedValueOnce(failing);
  try {
    const reply = await pullBack(id);
    expect(reply.statusCode).toBe(500);
    expect(reply.json()).toEqual(errorEnvelope("internal", "Internal error"));
    expect(failure).toHaveBeenCalledWith("ROLLBACK");
  } finally {
    failure.mockRestore();
  }
  expect(await marks()).toEqual([]);

  expect((await pullBack(id)).statusCode).toBe(200);
  expect(await head()).toEqual(beforeRows);
  expect((await readDraft()).json()).toEqual({ ...before.json(), sync: { state: "being_revised", same: false } });

  const [mark] = await Promise.all([pullBack(id), send(id, "abe", version.id)]);
  expect(mark.statusCode).toBe(200);
  expect(await marks()).toEqual([{ chapter_id: id, book_version: mark.json<PullBackWritten>().active_version_id }]);
});
