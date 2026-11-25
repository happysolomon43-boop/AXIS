import type { Pool, PoolClient, QueryConfig } from "pg";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { makePool, resetDb } from "./helpers.js";

const pool = makePool();

function wrapQuery(target: Pick<Pool | PoolClient, "query">) {
  return async (statement: string | QueryConfig, values?: unknown[]) => {
    const text = typeof statement === "string" ? statement : statement.text;
    if (text.includes("INSERT INTO books")) throw new Error("injected failure");

    return typeof statement === "string"
      ? target.query(statement, values)
      : target.query(statement);
  };
}

async function expectCounts(count: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM series) AS series,
            (SELECT count(*)::int FROM books) AS books`,
  );
  expect(rows).toEqual([{ series: count, books: count }]);
}

beforeEach(async () => {
  await resetDb(pool);
});

afterEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("Break-It Probe rolls back both rows when the Book insert fails and allows another creation", async () => {
  const failingPool = {
    async connect() {
      const client = await pool.connect();
      return { query: wrapQuery(client), release: client.release.bind(client) };
    },
    query: wrapQuery(pool),
  };
  const failingApp = buildApp({ pool: failingPool as unknown as Pool });
  const normalApp = buildApp({ pool });
  const request = {
    method: "POST" as const,
    url: "/series",
    headers: { "x-axis-user": "usr_alice", "content-type": "application/json" },
    payload: { title: "Ashfall" },
  };
  try {
    const failed = await failingApp.inject(request);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      error: { code: "internal", message: "Internal error", details: null },
    });
    await expectCounts(0);

    const recovered = await normalApp.inject(request);
    expect(recovered.statusCode).toBe(201);
    await expectCounts(1);
  } finally {
    await Promise.all([failingApp.close(), normalApp.close()]);
  }
});
