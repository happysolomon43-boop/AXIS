import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import { CHECKPOINT_OPERATIONS } from "../src/named-cuts/checkpoint-operations.js";
import { makePool, resetDb } from "./helpers.js";
import { alice, fixture, labels, state } from "./namedCutsFixtures.js";
import { seedVersionAs } from "./seed.js";

const pool = makePool();
const filename = "0015_restore_checkpoint_labels.sql";
const prior = "0014_snapshot_label_lifecycles.sql";
const dir = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const up = () => readFile(new URL(`../db/migrations/${filename}`, import.meta.url), "utf8");
const down = (file = filename) =>
  readFile(new URL(`../db/rollback/${file.replace(".sql", ".down.sql")}`, import.meta.url), "utf8");

const recorded = async (db: Pool | PoolClient) =>
  (await db.query("SELECT * FROM schema_migrations ORDER BY filename")).rows;
const names = async (client: PoolClient) =>
  (await client.query("SELECT * FROM named_cuts ORDER BY chapter_id, version_id")).rows;
const lifecycles = async (client: PoolClient) =>
  (await client.query("SELECT * FROM snapshot_label_lifecycles ORDER BY chapter_id, version_id")).rows;

async function isolated(check: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await check(client);
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

async function seedCheckpoints() {
  const drafting = await fixture(pool);
  const released = await fixture(pool);
  try {
    const { chapter: { id: x } } = await drafting.create();
    const a = await drafting.write(x, "The gate shut.", "send");
    const c1 = await seedVersionAs(pool, drafting.seriesId, x, "Text kept by Restore.", "checkpoint", "chapter.checkpoint");
    const r = await seedVersionAs(pool, drafting.seriesId, x, "The gate shut.", "restore", "chapter.restore");
    const b = await seedVersionAs(pool, drafting.seriesId, x, "The bell rang.", "draft_edit", "chapter.version.append");
    expect((await drafting.head(x, b, "Current draft.")).statusCode).toBe(200);

    const { chapter: { id: y } } = await released.create();
    await pool.query("UPDATE books SET status = 'released' WHERE id = $1", [released.bookId]);
    const c2 = await seedVersionAs(pool, released.seriesId, y, "Text kept in a released Book.", "checkpoint", "chapter.checkpoint");
    const odd = await seedVersionAs(pool, released.seriesId, y, "Not from Restore.", "checkpoint", "chapter.version.append");
    const conflict = await seedVersionAs(pool, released.seriesId, y, "Other draft.", "checkpoint", "chapter.keep_mine.checkpoint");
    return { x, c1, c2, unnamed: [a.version.id, r, b, odd, conflict] };
  } finally {
    await drafting.app.close();
    await released.app.close();
  }
}

beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

test("AXB-0114 AC1: backfills only Restore checkpoints, with the saved ledger time and live lifecycle", async () => {
  const { c1, c2, unnamed } = await seedCheckpoints();
  const before = await state(pool);
  const sql = await up();
  expect(sql).toContain(`'${CHECKPOINT_OPERATIONS.restore}'`);
  await isolated(async (client) => {
    expect((await client.query(sql)).rowCount).toBe(2);
    const expected = before.versions
      .filter((version) => [c1, c2].includes(version.id))
      .map(({ chapter_id, id, series_id, l_seq }) => ({
        chapter_id, version_id: id, series_id, l_seq, kind: "snapshot",
        label: "Before restore", pack_pins: {},
        created_at: before.ledger.find((entry) => entry.series_id === series_id && entry.l_seq === l_seq)?.at,
      }));
    expect(await names(client)).toEqual(expect.arrayContaining(expected));
    expect(await names(client)).toHaveLength(2);
    const live = await lifecycles(client);
    expect(live).toHaveLength(2);
    for (const row of expected) {
      expect(live).toContainEqual({
        chapter_id: row.chapter_id, version_id: row.version_id,
        snapshot_id: expect.any(String), state_token: expect.any(String),
        previous_token: null, removed_name_hash: null, removed_created_at: null,
      });
    }
    for (const id of unnamed) {
      expect(live.some((row) => row.version_id === id)).toBe(false);
    }
    for (const [table, rows] of [
      ["chapter_versions", before.versions], ["ledger", before.ledger],
      ["chapter_active", before.active], ["chapter_drafts", before.heads],
    ] as const) {
      expect((await client.query(`SELECT * FROM ${table}`)).rows).toHaveLength(rows.length);
    }
  });
  expect(await state(pool)).toEqual(before);
  expect(await labels(pool)).toEqual([]);
});

test("AXB-0114 AC2: rerunning the backfill respects a public Remove", async () => {
  const { x, c1, c2 } = await seedCheckpoints();
  const sql = await up();
  // The public route takes its own connection and must see the backfilled rows.
  await pool.query(sql);
  const { rows: [live] } = await pool.query(
    "SELECT * FROM snapshot_label_lifecycles WHERE chapter_id = $1 AND version_id = $2", [x, c1],
  );
  const app = buildApp({ pool });
  try {
    const reply = await app.inject({
      method: "POST", url: `/chapters/${x}/versions/${c1}/snapshot-label`, headers: alice,
      payload: { action: "remove", snapshot_id: live.snapshot_id, expected_token: live.state_token },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json().snapshot).toBeNull();
    await isolated(async (client) => {
      const removed = await lifecycles(client);
      expect(removed).toContainEqual({
        ...live, state_token: reply.json().snapshot_lifecycle.state_token, previous_token: live.state_token,
        removed_name_hash: expect.stringMatching(/^[0-9a-f]{64}$/), removed_created_at: expect.any(Date),
      });
      expect((await client.query(sql)).rowCount).toBe(0);
      expect((await client.query(sql)).rowCount).toBe(0);
      expect((await names(client)).map((row) => row.version_id)).toEqual([c2]);
      expect(await lifecycles(client)).toEqual(removed);
    });
  } finally {
    await app.close();
  }
});

test("AXB-0114 AC3: rollback preserves labels and refuses to discard removal state", async () => {
  const { c1 } = await seedCheckpoints();
  await pool.query(await up());
  await isolated(async (client) => {
    const migrations = await recorded(client);
    const original = await names(client);
    const live = await lifecycles(client);
    await client.query(await down());
    expect(migrations).toHaveLength(16);
    expect(await recorded(client)).toEqual(migrations.filter((row) => row.filename !== filename));
    expect(await names(client)).toEqual(original);
    expect(await lifecycles(client)).toEqual(live);

    await client.query("SAVEPOINT live");
    await client.query("DELETE FROM named_cuts WHERE version_id = $1", [c1]);
    await client.query(
      "UPDATE snapshot_label_lifecycles SET removed_name_hash = repeat('a', 64), removed_created_at = now() WHERE version_id = $1",
      [c1],
    );
    const removed = await lifecycles(client);
    const remaining = await names(client);
    await client.query("SAVEPOINT removed");
    const earlierDown = await down(prior);
    await expect(client.query(earlierDown)).rejects.toMatchObject({ code: "AX002" });
    await client.query("ROLLBACK TO SAVEPOINT removed");
    expect(await lifecycles(client)).toEqual(removed);
    expect(await names(client)).toEqual(remaining);
    expect(await recorded(client)).toEqual(migrations.filter((row) => row.filename !== filename));

    await client.query("ROLLBACK TO SAVEPOINT live");
    await client.query(earlierDown);
    expect(await recorded(client)).toEqual(migrations.filter((row) => row.filename !== filename && !row.filename.startsWith("0014_")));
    expect(await names(client)).toEqual(original);
    expect((await client.query("SELECT to_regclass('snapshot_label_lifecycles') AS name")).rows)
      .toEqual([{ name: null }]);
  });
});

test.each([false, true])("AXB-0114 AC3: real runner reapplies 0015 after rollback (also 0014: %s)", async (includePrior) => {
  const { c1, c2 } = await seedCheckpoints();
  await pool.query(await up());
  const original = await labels(pool);
  const migrations = (await recorded(pool)).map((row) => row.filename);
  const scripts = [await down(), ...(includePrior ? [await down(prior)] : [])];
  try {
    // The real runner must see the committed rollback records on its own connection.
    await pool.query(scripts.join("\n"));
    expect(await runMigrations(pool, dir)).toEqual(includePrior ? [prior, filename] : [filename]);
    expect(migrations).toHaveLength(16);
    expect((await recorded(pool)).map((row) => row.filename)).toEqual(migrations);
    expect(await labels(pool)).toEqual(original);
    expect(original.map((row) => row.version_id).sort()).toEqual([c1, c2].sort());
  } finally {
    await runMigrations(pool, dir);
  }
});
