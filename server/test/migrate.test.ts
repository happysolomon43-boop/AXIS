import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const testUrl = process.env.AXIS_TEST_DATABASE_URL;
if (!testUrl) throw new Error("AXIS_TEST_DATABASE_URL is required");

const pool = createPool(testUrl);
const serverDir = fileURLToPath(new URL("../", import.meta.url));
const first = "9001_probe_a.sql";
const second = "9002_probe_b.sql";
const broken = "9003_probe_bad.sql";
let dir: string;

async function clearProbes(): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS probe_a, probe_b, probe_c");
  await pool.query("DELETE FROM schema_migrations WHERE filename LIKE '90%'");
}

async function writeGoodMigrations(): Promise<void> {
  await writeFile(join(dir, second), "CREATE TABLE probe_b (x int);");
  await writeFile(join(dir, first), "CREATE TABLE probe_a (x int);");
  await writeFile(join(dir, ".gitkeep"), "This is not SQL.");
}

beforeEach(async () => {
  await clearProbes();
  dir = await mkdtemp(join(tmpdir(), "axis-migrations-"));
});

afterEach(async () => {
  try {
    await clearProbes();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await pool.end();
});

test("AC1 applies sorted SQL files once and ignores other files", async () => {
  await writeGoodMigrations();
  await expect(runMigrations(pool, dir)).resolves.toEqual([first, second]);
  const tables = await pool.query(
    "SELECT to_regclass('probe_a')::text AS a, to_regclass('probe_b')::text AS b",
  );
  expect(tables.rows).toEqual([{ a: "probe_a", b: "probe_b" }]);
  await expect(runMigrations(pool, dir)).resolves.toEqual([]);
});

test("AC2 serializes simultaneous migration runners", async () => {
  await writeGoodMigrations();
  const results = await Promise.all([
    runMigrations(pool, dir),
    runMigrations(pool, dir),
  ]);
  expect(results.flat().sort()).toEqual([first, second]);
});

test("AC3 rolls back a failing file and keeps the earlier migration", async () => {
  await writeFile(join(dir, first), "CREATE TABLE probe_a (x int);");
  await writeFile(
    join(dir, broken),
    "CREATE TABLE probe_c (x int); SELECT * FROM table_that_does_not_exist;",
  );

  await expect(runMigrations(pool, dir)).rejects.toMatchObject({ code: "42P01" });
  const tables = await pool.query(
    "SELECT to_regclass('probe_a')::text AS a, to_regclass('probe_c')::text AS c",
  );
  expect(tables.rows).toEqual([{ a: "probe_a", c: null }]);
  const records = await pool.query(
    "SELECT filename FROM schema_migrations WHERE filename = ANY($1::text[])",
    [[first, broken]],
  );
  expect(records.rows).toEqual([{ filename: first }]);
});

test("AC4 migration CLI requires DATABASE_URL and accepts the test database", () => {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const args = ["dist/scripts/migrate.js"];

  const missing = spawnSync(process.execPath, args, {
    cwd: serverDir, env: environment, encoding: "utf8",
  });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toBe("DATABASE_URL is required\n");

  environment.DATABASE_URL = testUrl;
  const configured = spawnSync(process.execPath, args, {
    cwd: serverDir, env: environment, encoding: "utf8",
  });
  expect(configured.status).toBe(0);
  expect(configured.stderr).toBe("");
  expect(configured.stdout).toBe("no pending migrations\n");
});
