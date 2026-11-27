import { observedWriteGuard } from "./helpers.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { expect } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import { seedSeries, intakeCounts } from "./seed.js";

export const alice = { "x-axis-user": "usr_alice" };
export const bob = { "x-axis-user": "usr_bob" };
export async function fixture(pool: Pool) {
  const { seriesId, bookId } = await seedSeries(pool);
  const app = buildApp({ pool });
  const create = async (content = "The gate shut.") => {
    const res = await app.inject({ method: "POST", url: "/books/" + bookId + "/chapters", headers: alice, payload: { content } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<ChapterCreated>();
  };
  const write = async (chapter: string, content: string, action: "versions" | "send" = "versions", source?: "import") => {
    const res = await app.inject({ method: "POST", url: "/chapters/" + chapter + "/" + action, headers: alice,
      payload: { content, ...await observedWriteGuard(pool, chapter), ...(source ? { source } : {}) } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<VersionWritten>();
  };
  const payload = (chapter: string, version: string, name?: string) =>
    ({ kind: "snapshot", chapter_id: chapter, version_id: version, ...(name === undefined ? {} : { name }) });
  const path = "/series/" + seriesId + "/named-cuts";
  const name = (chapter: string, version: string, label?: string, target: FastifyInstance = app) =>
    target.inject({ method: "POST", url: path, headers: alice, payload: payload(chapter, version, label) });
  const history = (chapter: string, target: FastifyInstance = app) =>
    target.inject({ method: "GET", url: "/chapters/" + chapter + "/history", headers: alice });
  const head = (chapter: string, version: string, content: string) =>
    app.inject({ method: "PUT", url: "/chapters/" + chapter + "/draft", headers: alice,
      payload: { content, base_version: version, base_revision: 0 } });
  return { app, seriesId, bookId, create, write, name, history, head, payload, path };
}
export async function state(pool: Pool) {
  return {
    counts: await intakeCounts(pool),
    versions: (await pool.query("SELECT * FROM chapter_versions ORDER BY id")).rows,
    ledger: (await pool.query("SELECT * FROM ledger ORDER BY series_id, l_seq")).rows,
    active: (await pool.query("SELECT * FROM chapter_active ORDER BY chapter_id, since_l")).rows,
    heads: (await pool.query("SELECT * FROM chapter_drafts ORDER BY chapter_id")).rows,
  };
}
export const labels = async (pool: Pool) => (await pool.query("SELECT * FROM named_cuts ORDER BY chapter_id, version_id")).rows;
