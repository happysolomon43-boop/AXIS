import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { makePool, resetDb } from "./helpers.js";

const pool = makePool();
const migrations = fileURLToPath(new URL("../db/migrations", import.meta.url));
const rollbacks = fileURLToPath(new URL("../db/rollback", import.meta.url));

function insertSeries(title = "Ashfall", ownerId = "usr_alice") {
  return pool.query<{ id: string }>(
    "INSERT INTO series (owner_id, title) VALUES ($1, $2) RETURNING *",
    [ownerId, title],
  );
}

function insertBook(seriesId: string, title = "Ashfall", authorId = "usr_alice") {
  return pool.query(
    `INSERT INTO books (series_id, title, ordinal, author_id)
     VALUES ($1, $2, 1, $3) RETURNING *`,
    [seriesId, title, authorId],
  );
}

async function containerObjects() {
  const { rows } = await pool.query(
    `SELECT to_regclass('series')::text AS series,
            to_regclass('books')::text AS books,
            to_regtype('book_status')::text AS book_status`,
  );
  return rows;
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("AC1 creates the exact container columns and defaults", async () => {
  const { rows: [series] } = await insertSeries();
  expect(series).toEqual({
    id: expect.stringMatching(/^ser_[0-9a-f]{12}$/),
    owner_id: "usr_alice",
    title: "Ashfall",
    genre_rubric_id: null,
    foundation: {},
  });

  const { rows: [book] } = await insertBook(series!.id);
  expect(book).toEqual({
    id: expect.stringMatching(/^bk_[0-9a-f]{12}$/),
    series_id: series!.id,
    title: "Ashfall",
    ordinal: 1,
    label: null,
    status: "drafting",
    author_id: "usr_alice",
    language: "English",
  });

  const { rows } = await pool.query(
    `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name IN ('series', 'books')
     GROUP BY table_name ORDER BY table_name`,
  );
  expect(rows).toEqual([
    {
      table_name: "books",
      columns: ["id", "series_id", "title", "ordinal", "label", "status", "author_id", "language"],
    },
    {
      table_name: "series",
      columns: ["id", "owner_id", "title", "genre_rubric_id", "foundation"],
    },
  ]);
});

test("AC2 enforces title length, title trimming, and user identifiers", async () => {
  const a200 = "a".repeat(200);
  const { rows: [series] } = await insertSeries(a200);
  expect(series).toBeDefined();
  await expect(insertBook(series!.id, a200)).resolves.toMatchObject({ rowCount: 1 });

  for (const title of ["", " ", " Ashfall", "Ashfall ", "a".repeat(201)]) {
    await expect(insertSeries(title)).rejects.toMatchObject({ code: "23514" });
    await expect(insertBook(series!.id, title)).rejects.toMatchObject({ code: "23514" });
  }
  await expect(insertSeries("Ashfall", "alice")).rejects.toMatchObject({ code: "23514" });
  await expect(insertBook(series!.id, "Ashfall", "alice")).rejects.toMatchObject({ code: "23514" });
});

test("AC3 enforces the restricted foreign key, ordinal, enum, and foundation", async () => {
  const { rows: [series] } = await insertSeries();
  const seriesId = series!.id;
  const { rows: [book] } = await insertBook(seriesId);
  await expect(insertBook("ser_000000000000")).rejects.toMatchObject({ code: "23503" });
  await expect(pool.query("DELETE FROM series WHERE id = $1", [seriesId]))
    .rejects.toMatchObject({ code: "23503" });
  await expect(pool.query("UPDATE books SET ordinal = 0 WHERE id = $1", [book.id]))
    .rejects.toMatchObject({ code: "23514" });
  await expect(pool.query("UPDATE books SET status = 'archived' WHERE id = $1", [book.id]))
    .rejects.toMatchObject({ code: "22P02" });
  await expect(pool.query("UPDATE series SET foundation = '[]' WHERE id = $1", [seriesId]))
    .rejects.toMatchObject({ code: "23514" });
});

test("AC4 rolls back and reapplies every migration", async () => {
  const downFiles = (await readdir(rollbacks)).filter((name) => name.endsWith(".down.sql")).sort().reverse();
  const upFiles = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();

  for (const name of downFiles) {
    await pool.query(await readFile(join(rollbacks, name), "utf8"));
  }
  expect(await containerObjects()).toEqual([{ series: null, books: null, book_status: null }]);
  expect((await pool.query("SELECT filename FROM schema_migrations")).rows).toEqual([]);

  await expect(runMigrations(pool, migrations)).resolves.toEqual(upFiles);
  expect(await containerObjects()).toEqual([
    { series: "series", books: "books", book_status: "book_status" },
  ]);
});
