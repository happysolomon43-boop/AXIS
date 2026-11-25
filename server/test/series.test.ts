import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const json = { ...alice, "content-type": "application/json" };
const fieldMessage = "must be 1 to 200 characters and must not contain NUL";
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb(pool);
  app = buildApp({ pool });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

function post(payload: object | string, headers = json) {
  return app.inject({ method: "POST", url: "/series", headers, payload });
}

async function expectCounts(count: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM series) AS series,
            (SELECT count(*)::int FROM books) AS books`,
  );
  expect(rows).toEqual([{ series: count, books: count }]);
}

test("AC1 creates one Series and its first Book with the default title and fields", async () => {
  const response = await post({ title: "  Ashfall  " });
  expect(response.statusCode).toBe(201);
  const { series, books } = response.json<SeriesTree>();
  expect(series).toEqual({
    id: expect.stringMatching(/^ser_[0-9a-f]{12}$/),
    owner_id: "usr_alice",
    title: "Ashfall",
    genre_rubric_id: null,
    foundation: {},
  });
  expect(books).toEqual([{
    id: expect.stringMatching(/^bk_[0-9a-f]{12}$/),
    series_id: series.id,
    title: "Ashfall",
    ordinal: 1,
    label: null,
    status: "drafting",
    author_id: "usr_alice",
    language: "English",
  }]);
  await expectCounts(1);
});

test("AC2 uses the separately supplied Book title and creates a new Series on repeat", async () => {
  const input = { title: "Ashfall", book_title: "  The Third Bell " };
  const response = await post(input);
  expect(response.statusCode).toBe(201);
  const tree = response.json<SeriesTree>();
  expect(tree.series.title).toBe("Ashfall");
  expect(tree.books[0]?.title).toBe("The Third Bell");

  const repeated = await post(input);
  expect(repeated.statusCode).toBe(201);
  expect(repeated.json<SeriesTree>().series.id).not.toBe(tree.series.id);
  await expectCounts(2);
});

test("AC3 validates the schema, code point limits, NUL, JSON and the body limit", async () => {
  const invalidSchema = [
    [{}, "", "must have required property 'title'"],
    [{ title: 5 }, "/title", "must be string"],
    [{ title: "Ashfall", extra: 1 }, "", "must NOT have additional properties"],
    [{ title: "Ashfall", book_title: null }, "/book_title", "must be string"],
  ] as const;
  for (const [payload, path, message] of invalidSchema) {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "Request validation failed",
        details: { errors: [{ path, message }] },
      },
    });
  }

  const invalidTitles = [
    [{ title: "" }, "/title"],
    [{ title: "   " }, "/title"],
    [{ title: "a".repeat(201) }, "/title"],
    [{ title: "Ashfall", book_title: "" }, "/book_title"],
    [{ title: "A\u0000B" }, "/title"],
    [{ title: "😀".repeat(201) }, "/title"],
  ] as const;
  for (const [payload, path] of invalidTitles) {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "validation_failed",
        message: "Request validation failed",
        details: { errors: [{ path, message: fieldMessage }] },
      },
    });
  }

  const malformed = await post("{bad");
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json()).toEqual({
    error: { code: "validation_failed", message: "Request could not be parsed", details: null },
  });

  const unsupported = await post('{"title":"Ashfall"}', { ...alice, "content-type": "text/plain" });
  expect(unsupported.statusCode).toBe(415);
  expect(unsupported.json()).toEqual({
    error: { code: "unsupported_media_type", message: "Content-Type must be application/json", details: null },
  });

  const oversized = await post(" ".repeat(1048577));
  expect(oversized.statusCode).toBe(413);
  expect(oversized.json()).toEqual({
    error: { code: "payload_too_large", message: "Request body too large", details: null },
  });
  await expectCounts(0);

  for (const title of ["a".repeat(200), "😀".repeat(200)]) {
    const response = await post({ title });
    expect(response.statusCode).toBe(201);
    expect(response.json<SeriesTree>().series.title).toBe(title);
  }
  await expectCounts(2);
});

test("AC4 reads the same tree only for its owner and returns exact errors", async () => {
  const created = await post({ title: "Ashfall" });
  expect(created.statusCode).toBe(201);
  const { series } = created.json<SeriesTree>();
  const url = `/series/${series.id}`;
  const owner = await app.inject({ method: "GET", url, headers: alice });
  expect(owner.statusCode).toBe(200);
  expect(owner.json()).toEqual(created.json());

  const inaccessible = [
    { url, headers: { "x-axis-user": "usr_bob" } },
    { url: "/series/ser_000000000000", headers: alice },
    { url: "/series/not-an-id", headers: alice },
    { url: "/series/%00", headers: alice },
    { url: `/series/${"a".repeat(65)}`, headers: alice },
    { url: `/series/${"a".repeat(101)}`, headers: alice },
  ];
  for (const request of inaccessible) {
    const response = await app.inject({ method: "GET", ...request });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "not_found", message: "Series not found", details: null },
    });
  }

  const anonymous = await app.inject({ method: "GET", url });
  expect(anonymous.statusCode).toBe(401);
  expect(anonymous.json()).toEqual({
    error: {
      code: "auth_required",
      message: "Missing or invalid X-Axis-User header",
      details: null,
    },
  });
});
