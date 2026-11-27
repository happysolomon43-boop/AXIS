import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterHistory } from "../src/corpus/repo.js";
import type { WriteResult } from "../src/writes/receipts.js";
import { makePool, resetDb } from "./helpers.js";
import { alice, fixture, labels, state } from "./namedCutsFixtures.js";

const pool = makePool();
afterAll(() => pool.end());

test("AXB-0118 AC2: a failed label INSERT rolls back Restore, which lands once after the fault is removed", async () => {
  await resetDb(pool);
  const f = await fixture(pool);
  const migrations = async () =>
    (await pool.query("SELECT * FROM schema_migrations ORDER BY filename")).rows;
  const beforeMigrations = await migrations();
  try {
    // Build the two historical versions via the Corpus intake path.
    const a = await f.create("The gate shut.");
    const chapterId = a.chapter.id;
    const activate = await f.app.inject({ method: "POST", url: `/chapters/${chapterId}/activate`, headers: alice,
      payload: { version_id: a.version.id } });
    expect(activate.statusCode).toBe(200);
    const b = await f.write(chapterId, "The bell rang.");
    const kept = "The bell rang again.";
    const head = await f.head(chapterId, b.version.id, kept);
    expect(head.statusCode, head.body).toBe(200);
    expect(head.json()).toMatchObject({ base_version: b.version.id, revision: 1 });

    const history = async () => {
      const response = await f.history(chapterId);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<ChapterHistory>();
    };
    const lifecycles = async () => (await pool.query("SELECT * FROM snapshot_label_lifecycles")).rows;
    const before = await state(pool);
    const beforeLabels = await labels(pool);
    const beforeLifecycle = await lifecycles();
    const beforeHistory = await history();
    expect(beforeHistory.versions.map(({ id }) => id)).toEqual([b.version.id, a.version.id]);
    expect(beforeHistory.active_version_id).toBe(a.version.id);
    expect(before.heads).toEqual([{ chapter_id: chapterId, base_version: b.version.id, revision: 1, content: kept }]);

    const request = {
      method: "POST" as const, url: `/chapters/${chapterId}/restore`,
      headers: alice, payload: { request_id: randomUUID(), version_id: a.version.id },
    };
    const client = await pool.connect();
    const original = client.query.bind(client);
    let began = false;
    let checkpointWritten = false;
    let restoreAttempted = false;
    let injected = false;
    let released = false;
    const spy = vi.spyOn(client, "query").mockImplementation((async (sql: string, values?: unknown[]) => {
      if (began && !injected && sql.startsWith("INSERT INTO named_cuts (")) {
        injected = true;
        throw new Error("injected");
      }
      if (values?.[2] === "chapter.restore") restoreAttempted = true;
      const result = await original(sql, values);
      if (sql === "BEGIN") began = true;
      if (values?.[2] === "chapter.checkpoint") checkpointWritten = true;
      return result;
    }) as typeof client.query);
    const faultPool = {
      query: pool.query.bind(pool),
      connect: async () => ({
        query: client.query.bind(client),
        release(discard?: boolean) {
          spy.mockRestore();
          client.release(discard);
          released = true;
        },
      }) as unknown as PoolClient,
    } as unknown as Pool;
    const broken = buildApp({ pool: faultPool });
    try {
      const rejected = await broken.inject(request);
      expect(injected).toBe(true);
      expect(checkpointWritten).toBe(true);
      expect(restoreAttempted).toBe(false);
      expect(released).toBe(true);
      expect(rejected.statusCode, rejected.body).toBe(500);
      expect(rejected.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
    } finally {
      spy.mockRestore();
      if (!released) client.release(true);
      await broken.close();
    }

    expect(await state(pool)).toEqual(before);
    expect(await labels(pool)).toEqual(beforeLabels);
    expect(await lifecycles()).toEqual(beforeLifecycle);
    expect(await history()).toEqual(beforeHistory);

    const retry = await f.app.inject(request);
    expect(retry.statusCode, retry.body).toBe(201);
    const landed = retry.json<WriteResult>();
    expect(landed.checkpoint_version_id).toEqual(expect.any(String));
    const all = await history();
    expect(all.active_version_id).toBe(a.version.id);
    expect(all.versions.map(({ id, source }) => [id, source])).toEqual([
      [landed.version.id, "restore"], [landed.checkpoint_version_id, "checkpoint"],
      [b.version.id, "draft_edit"], [a.version.id, "draft_edit"],
    ]);
    const named = all.versions.filter((row) => row.snapshot !== null);
    expect(named).toEqual([expect.objectContaining({
      id: landed.checkpoint_version_id,
      snapshot: expect.objectContaining({ name: "Before restore" }),
      snapshot_lifecycle: expect.objectContaining({ previous_token: null }),
      can_name_snapshot: false,
    })]);
    const after = await state(pool);
    expect(after.versions).toHaveLength(before.versions.length + 2);
    expect(after.ledger.slice(before.ledger.length).map(({ op }) => op)).toEqual(["chapter.checkpoint", "chapter.restore"]);
    expect(after.heads).toEqual([]);
    expect(after.active).toEqual(before.active);
    expect(await labels(pool)).toHaveLength(1);
    expect(await lifecycles()).toHaveLength(1);
  } finally {
    try { await f.app.close(); } finally { await resetDb(pool); }
  }
  expect(await migrations()).toEqual(beforeMigrations);
  expect(beforeMigrations).toHaveLength(16);
});
