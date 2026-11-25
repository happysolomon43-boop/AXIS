import type { Pool, PoolClient, QueryConfig } from "pg";
import { afterAll, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated } from "../src/corpus/repo.js";
import type { SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { corpusCounts } from "./seed.js";

const pool = makePool();

function injectCommitFailure(client: PoolClient) {
  return async (statement: string | QueryConfig, values?: unknown[]) => {
    const sql = typeof statement === "string" ? statement : statement.text;
    if (sql.trim() === "COMMIT") throw new Error("injected failure");

    return typeof statement === "string"
      ? client.query(statement, values)
      : client.query(statement);
  };
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("Break-It Probe rolls back a failed chapter commit without consuming its ledger position", async () => {
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
      payload: { content: "abc" },
    };

    const wrapped = {
      async connect() {
        const client = await pool.connect();
        return { query: injectCommitFailure(client), release: client.release.bind(client) };
      },
      query: pool.query.bind(pool),
    };
    const failingApp = buildApp({ pool: wrapped as unknown as Pool });
    try {
      const failed = await failingApp.inject(request);
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
      expect(await corpusCounts(pool)).toEqual({ ledger: 0, chapters: 0, versions: 0, active: 0 });
    } finally {
      await failingApp.close();
    }

    const successful = await app.inject(request);
    expect(successful.statusCode).toBe(201);
    expect(successful.json<ChapterCreated>().version.l_seq).toBe(1);
    expect(await corpusCounts(pool)).toEqual({ ledger: 1, chapters: 1, versions: 1, active: 0 });
  } finally {
    await app.close();
  }
});
