import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { insertCheckpointLabel } from "../src/named-cuts/checkpoint-label.js";
import type { CheckpointOperation } from "../src/named-cuts/checkpoint-operations.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries, seedVersion, seedVersionAs } from "./seed.js";

const pool = makePool();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

test("AXB-0115 AC1–AC2: writes one label and its lifecycle on the caller's transaction", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const { chapterId, versionId: saved } = await seedVersion(pool, seriesId, bookId);
  const { chapterId: otherChapter } = await seedVersion(pool, seriesId, bookId);
  const send = await seedVersionAs(pool, seriesId, chapterId, "Sent.", "send", "chapter.send");
  const restored = await seedVersionAs(pool, seriesId, chapterId, "Restored.", "restore", "chapter.restore");
  const checkpoint = await seedVersionAs(pool, seriesId, chapterId, "Unsaved.", "checkpoint", "chapter.checkpoint");
  const other = await seedVersionAs(pool, seriesId, otherChapter, "Other.", "checkpoint", "chapter.checkpoint");
  const chapter = { id: chapterId, series_id: seriesId };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ledgerCount = async () => (await client.query("SELECT count(*) FROM ledger")).rows;
    const count = await ledgerCount();
    const query = vi.spyOn(client, "query");
    try {
      await expect(insertCheckpointLabel(client, chapter, checkpoint, "paste" as CheckpointOperation))
        .rejects.toThrow(new Error("unknown checkpoint operation"));
      expect(query).not.toHaveBeenCalled();

      await insertCheckpointLabel(client, chapter, checkpoint, "restore");
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
    const { rows: [version] } = await client.query("SELECT l_seq FROM chapter_versions WHERE id = $1", [checkpoint]);
    const getLabels = async () => (await client.query("SELECT * FROM named_cuts")).rows;
    const getLifecycles = async () => (await client.query("SELECT * FROM snapshot_label_lifecycles")).rows;
    const labels = await getLabels();
    const lifecycles = await getLifecycles();
    expect(labels).toEqual([{
      chapter_id: chapterId, version_id: checkpoint, series_id: seriesId, l_seq: version.l_seq,
      label: "Before restore", kind: "snapshot", pack_pins: {}, created_at: expect.any(Date),
    }]);
    expect(lifecycles).toEqual([{
      chapter_id: chapterId, version_id: checkpoint, snapshot_id: expect.stringMatching(uuid),
      state_token: expect.stringMatching(uuid), previous_token: null,
      removed_name_hash: null, removed_created_at: null,
    }]);
    expect(await ledgerCount()).toEqual(count);

    for (const id of [send, restored, saved, other, "ver_000000000000"]) {
      await expect(insertCheckpointLabel(client, chapter, id, "restore"))
        .rejects.toThrow(new Error("checkpoint label not written"));
    }
    await expect(insertCheckpointLabel(client, { ...chapter, series_id: "ser_000000000000" }, checkpoint, "restore"))
      .rejects.toThrow(new Error("checkpoint label not written"));
    await client.query("SAVEPOINT duplicate");
    await expect(insertCheckpointLabel(client, chapter, checkpoint, "restore")).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate");
    await client.query("RELEASE SAVEPOINT duplicate");
    expect(await getLabels()).toEqual(labels);
    expect(await getLifecycles()).toEqual(lifecycles);
    expect(await ledgerCount()).toEqual(count);
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
  expect((await pool.query("SELECT * FROM named_cuts")).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM snapshot_label_lifecycles")).rows).toEqual([]);
});
