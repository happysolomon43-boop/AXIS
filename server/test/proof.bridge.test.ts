import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated, ChapterDetail, VersionWritten } from "../src/corpus/repo.js";
import type { SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { intakeCounts } from "./seed.js";

const pool = makePool();

afterAll(async () => {
  await pool.end();
});

test("AC1 applies all nine migrations and installs word count and version activation", async () => {
  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations WHERE filename < '0010' ORDER BY filename",
  );
  expect(rows.map(({ filename }) => filename)).toEqual([
    "0001_containers.sql", "0002_ledger.sql", "0003_corpus.sql", "0004_commit_inputs.sql",
    "0005_intake_tables.sql", "0006_intake_functions.sql", "0007_commit_inputs_intake.sql",
    "0008_commit_inputs_activate.sql", "0009_word_count.sql",
  ]);
  expect((await pool.query("SELECT axis_word_count('abc') AS count")).rows).toEqual([{ count: 1 }]);
  const { rows: [definition] } = await pool.query<{ body: string }>(
    "SELECT pg_get_functiondef('commit_inputs(text,text,text,text,jsonb)'::regprocedure) AS body",
  );
  expect(definition?.body).toContain("'activate'");
});

test("Break-It Probe rolls back send on activation failure and preserves the next ledger position", async () => {
  await resetDb(pool);
  const app = buildApp({ pool });
  const headers = { "x-axis-user": "usr_alice", "content-type": "application/json" };
  try {
    const created = await app.inject({
      method: "POST", url: "/series", headers, payload: { title: "Ashfall" },
    });
    expect(created.statusCode).toBe(201);
    const { books } = created.json<SeriesTree>();
    const first = await app.inject({
      method: "POST", url: `/books/${books[0]!.id}/chapters`, headers, payload: { content: "abc" },
    });
    expect(first.statusCode).toBe(201);
    const { chapter, version } = first.json<ChapterCreated>();
    expect(version.l_seq).toBe(1);
    const before = { ledger: 1, chapters: 1, versions: 1, active: 0, blocks: 1, scenes: 1 };
    expect(await intakeCounts(pool)).toEqual(before);
    const request = {
      method: "POST" as const,
      url: `/chapters/${chapter.id}/send`,
      headers,
      payload: { content: "hello" },
    };

    try {
      await pool.query(`
        CREATE FUNCTION probe_fail_active_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'injected failure';
        END;
        $$;
        CREATE TRIGGER probe_fail_active BEFORE INSERT ON chapter_active
            FOR EACH ROW EXECUTE FUNCTION probe_fail_active_insert();
      `);

      const failed = await app.inject(request);
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
      expect(await intakeCounts(pool)).toEqual(before);
      const read = await app.inject({ method: "GET", url: `/chapters/${chapter.id}`, headers });
      expect(read.statusCode).toBe(200);
      const detail = read.json<ChapterDetail>();
      expect(detail.version).toEqual({ ...version, content: "abc" });
      expect(detail.active_version_id).toBeNull();
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS probe_fail_active ON chapter_active;
        DROP FUNCTION IF EXISTS probe_fail_active_insert();
      `);
    }

    const { rows: remaining } = await pool.query(`
      SELECT to_regprocedure('probe_fail_active_insert()') AS probe_function,
             EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgrelid = 'chapter_active'::regclass AND tgname = 'probe_fail_active') AS probe_trigger
    `);
    expect(remaining).toEqual([{ probe_function: null, probe_trigger: false }]);

    const succeeded = await app.inject(request);
    expect(succeeded.statusCode).toBe(201);
    const result = succeeded.json<VersionWritten>();
    expect(result.version).toMatchObject({ l_seq: 2, version_no: 2, parent_version: version.id, source: "send" });
    expect(result.active_version_id).toBe(result.version.id);
    expect(await intakeCounts(pool)).toEqual({ ledger: 2, chapters: 1, versions: 2, active: 1, blocks: 2, scenes: 2 });
  } finally {
    try {
      await app.close();
    } finally {
      await resetDb(pool);
    }
  }
});
