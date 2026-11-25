import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { makePool } from "./helpers.js";

const pool = makePool();
const migration = "0009_word_count.sql";
const whitespace = [
  9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195,
  8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288,
].map((point) => String.fromCodePoint(point));

async function count(input: string | null) {
  return (await pool.query<{ value: number | null }>(
    "SELECT axis_word_count($1) AS value", [input],
  )).rows[0]!.value;
}

afterAll(async () => {
  await pool.end();
});

test("AC1 counts runs outside the exact whitespace set at every supported size", async () => {
  const cases: Array<[string, number]> = [
    ["abc", 1], ["hello world", 2], ["  a \t b\n\nc  ", 3], ["", 0], [whitespace.join(""), 0],
    ["Chapter One", 2], ["a-b", 1], ["He said “hi.”", 3], ["a\u200bb", 1], ["a\ufeffb", 1],
    ["a".repeat(1000000), 1], ["a b ".repeat(250000), 500000],
  ];
  for (const [value, expected] of cases) expect(await count(value)).toBe(expected);
  for (const char of whitespace) expect(await count("a" + char + "b")).toBe(2);
  expect(await count("a" + whitespace.join("") + "b")).toBe(2);
});

test("AC2 installs a strict immutable integer function and restores it after rollback", async () => {
  const { rows } = await pool.query(
    `SELECT provolatile, proisstrict, prorettype::regtype::text AS result
     FROM pg_proc WHERE oid = 'axis_word_count(text)'::regprocedure`,
  );
  expect(rows).toEqual([{ provolatile: "i", proisstrict: true, result: "integer" }]);
  expect(await count(null)).toBeNull();

  await pool.query(await readFile(new URL("../db/rollback/0009_word_count.down.sql", import.meta.url), "utf8"));
  expect((await pool.query("SELECT to_regprocedure('axis_word_count(text)') AS procedure")).rows)
    .toEqual([{ procedure: null }]);
  expect((await pool.query("SELECT filename FROM schema_migrations WHERE filename = $1", [migration])).rows)
    .toEqual([]);
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  expect(await runMigrations(pool, dir)).toEqual([migration]);
  expect(await count("abc")).toBe(1);
});
