import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated, ChapterDetail } from "../src/corpus/repo.js";
import type { SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { intakeCounts } from "./seed.js";

const pool = makePool();

afterAll(async () => {
  await pool.end();
});

test("AC1 applies all seven migrations and installs the complete intake schema", async () => {
  const { rows: migrations } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  expect(migrations.map(({ filename }) => filename)).toEqual([
    "0001_containers.sql", "0002_ledger.sql", "0003_corpus.sql", "0004_commit_inputs.sql",
    "0005_intake_tables.sql", "0006_intake_functions.sql", "0007_commit_inputs_intake.sql",
  ]);

  const expected = [
    "axis_fold(text)", "axis_normalize(text)", "axis_sentences(text)", "axis_segment(text)",
    "axis_hints_hash(jsonb)", "axis_intake_store(text,jsonb)", "axis_intake_backfill()",
  ];
  const { rows: signatures } = await pool.query(
    "SELECT to_regprocedure(signature)::text AS signature FROM unnest($1::text[]) AS input(signature)",
    [expected],
  );
  expect(signatures).toEqual(expected.map((signature) => ({ signature })));
  const { rows: tables } = await pool.query(
    "SELECT to_regclass('blocks')::text AS blocks, to_regclass('scenes')::text AS scenes",
  );
  expect(tables).toEqual([{ blocks: "blocks", scenes: "scenes" }]);
});

test("Break-It Probe rolls back an intake that fails on the first scene and reuses its position", async () => {
  await resetDb(pool);
  const app = buildApp({ pool });
  const headers = { "x-axis-user": "usr_alice", "content-type": "application/json" };
  try {
    const series = await app.inject({
      method: "POST", url: "/series", headers, payload: { title: "Ashfall" },
    });
    expect(series.statusCode).toBe(201);
    const { books } = series.json<SeriesTree>();
    const request = {
      method: "POST" as const,
      url: `/books/${books[0]!.id}/chapters`,
      headers,
      payload: { content: "She turned the key." },
    };

    try {
      await pool.query(`
        CREATE FUNCTION probe_fail_scene_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'injected failure';
        END;
        $$;
        CREATE TRIGGER probe_fail_scenes BEFORE INSERT ON scenes
            FOR EACH ROW EXECUTE FUNCTION probe_fail_scene_insert();
      `);

      const failed = await app.inject(request);
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({
        error: { code: "internal", message: "Internal error", details: null },
      });
      expect(await intakeCounts(pool)).toEqual({ ledger: 0, chapters: 0, versions: 0, active: 0, blocks: 0, scenes: 0 });
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS probe_fail_scenes ON scenes;
        DROP FUNCTION IF EXISTS probe_fail_scene_insert();
      `);
    }

    const { rows: probeObjects } = await pool.query(`
      SELECT to_regprocedure('probe_fail_scene_insert()') AS probe_function,
             EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgrelid = 'scenes'::regclass AND tgname = 'probe_fail_scenes') AS probe_trigger
    `);
    expect(probeObjects).toEqual([{ probe_function: null, probe_trigger: false }]);

    const created = await app.inject(request);
    expect(created.statusCode).toBe(201);
    const { chapter, version } = created.json<ChapterCreated>();
    expect(version.l_seq).toBe(1);
    expect(await intakeCounts(pool)).toEqual({ ledger: 1, chapters: 1, versions: 1, active: 0, blocks: 1, scenes: 1 });

    const returned = await app.inject({ method: "GET", url: `/chapters/${chapter.id}`, headers });
    expect(returned.statusCode).toBe(200);
    const detail = returned.json<ChapterDetail>();
    expect(detail.blocks).toHaveLength(1);
    expect(detail.scenes).toHaveLength(1);
  } finally {
    try {
      await app.close();
    } finally {
      await resetDb(pool);
    }
  }
});
