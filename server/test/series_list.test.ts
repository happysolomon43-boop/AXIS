import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { SeriesRow, SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";

const pool = makePool();
let app: FastifyInstance;

beforeEach(async () => {
  await resetDb(pool);
  app = buildApp({ pool });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

async function create(title: string, owner = "usr_alice"): Promise<SeriesRow> {
  const response = await app.inject({
    method: "POST",
    url: "/series",
    headers: { "x-axis-user": owner },
    payload: { title },
  });
  expect(response.statusCode).toBe(201);
  return response.json<SeriesTree>().series;
}

function read(owner?: string, url = "/series") {
  return app.inject({
    method: "GET",
    url,
    headers: owner === undefined ? {} : { "x-axis-user": owner },
  });
}

async function counts() {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM series) AS series,
            (SELECT count(*) FROM books) AS books,
            (SELECT count(*) FROM ledger) AS ledger,
            (SELECT count(*) FROM chapters) AS chapters,
            (SELECT count(*) FROM chapter_versions) AS chapter_versions,
            (SELECT count(*) FROM chapter_active) AS chapter_active,
            (SELECT count(*) FROM blocks) AS blocks,
            (SELECT count(*) FROM scenes) AS scenes`,
  );
  return rows;
}

test("AC1 lists only the owner's Series and sorts titles and tied IDs bytewise", async () => {
  const thirdBell = await create("The Third Bell");
  const ashfall = await create("Ashfall");
  const bobsAshfall = await create("Ashfall", "usr_bob");

  const alice = await read("usr_alice");
  expect(alice.statusCode).toBe(200);
  expect(alice.json()).toEqual({
    series: [ashfall, thirdBell].map(({ id, title }) => ({
      id, title, owner_id: "usr_alice", genre_rubric_id: null, foundation: {},
    })),
  });
  const bob = await read("usr_bob");
  expect(bob.statusCode).toBe(200);
  expect(bob.json()).toEqual({ series: [bobsAshfall] });
  const carol = await read("usr_carol");
  expect(carol.statusCode).toBe(200);
  expect(carol.json()).toEqual({ series: [] });

  await resetDb(pool);
  for (const title of ["b", "B", "a"]) await create(title);
  const ties = [await create("Same"), await create("Same")];
  const sorted = (await read("usr_alice")).json<{ series: SeriesRow[] }>().series;
  expect(sorted.map(({ title }) => title)).toEqual(["B", "Same", "Same", "a", "b"]);
  expect(sorted.filter(({ title }) => title === "Same").map(({ id }) => id))
    .toEqual(ties.map(({ id }) => id).sort());
});

test("AC2 checks the header before using the pool, ignores query parameters and writes nothing", async () => {
  const alice = await create("Ashfall");
  await create("The Third Bell", "usr_bob");
  const before = await counts();
  const connect = vi.spyOn(pool, "connect");
  for (const user of [undefined, "bob"]) {
    const response = await read(user);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "auth_required",
        message: "Missing or invalid X-Axis-User header",
        details: null,
      },
    });
  }
  expect(connect).not.toHaveBeenCalled();

  const response = await read("usr_alice", "/series?owner=usr_bob");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ series: [alice] });
  connect.mockRejectedValueOnce(new Error("Database unavailable"));
  const failed = await read("usr_alice");
  expect(failed.statusCode).toBe(500);
  expect(failed.json()).toEqual({
    error: { code: "internal", message: "Internal error", details: null },
  });
  expect(await counts()).toEqual(before);
});
