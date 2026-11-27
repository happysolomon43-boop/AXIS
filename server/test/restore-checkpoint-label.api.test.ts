import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import type { ChapterHistory } from "../src/corpus/repo.js";
import type { WriteResult } from "../src/writes/receipts.js";
import { makePool, resetDb } from "./helpers.js";
import { alice, bob, fixture, labels, state } from "./namedCutsFixtures.js";
import { seedSeries } from "./seed.js";

const pool = makePool();
const kept = "The bell rang again.";
let f: Awaited<ReturnType<typeof fixture>>;
let chapterId: string;
let a: string;
let b: string;

beforeEach(async () => {
  await resetDb(pool);
  f = await fixture(pool);
  chapterId = (await f.create()).chapter.id;
  a = (await f.write(chapterId, "The gate shut.", "send")).version.id;
  b = (await f.write(chapterId, "The bell rang.")).version.id;
});
afterEach(() => f.app.close());
afterAll(() => pool.end());

const lifecycleRows = async () =>
  (await pool.query("SELECT * FROM snapshot_label_lifecycles ORDER BY chapter_id, version_id")).rows;

const requestRestore = (chapter = chapterId, version = a, headers = alice) =>
  f.app.inject({
    method: "POST", url: `/chapters/${chapter}/restore`, headers, payload: { request_id: randomUUID(), version_id: version },
  });

async function restore(version = a) {
  const response = await requestRestore(chapterId, version);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<WriteResult>();
}

async function putHead(base = b, content = kept) {
  const head = await f.head(chapterId, base, content);
  expect(head.statusCode, head.body).toBe(200);
  expect(head.json()).toMatchObject({ base_version: base, revision: 1 });
}

test("AXB-0116 AC1: only the kept checkpoint receives the name in the Restore transaction", async () => {
  await putHead();
  const before = await state(pool);
  const written = await restore();
  expect(written).toMatchObject({
    chapter: { id: chapterId, book_id: f.bookId, order_key: "0000001000" },
    version: {
      id: expect.stringMatching(/^ver_[0-9a-f]{12}$/), chapter_id: chapterId, source: "restore",
      version_no: 5, parent_version: written.checkpoint_version_id, l_seq: expect.any(Number),
      text_hash: expect.any(String), hints_hash: expect.any(String),
    },
    active_version_id: a,
    checkpoint_version_id: expect.stringMatching(/^ver_[0-9a-f]{12}$/),
  });
  const id = written.checkpoint_version_id;
  const after = await state(pool);
  expect(after.versions).toHaveLength(before.versions.length + 2);
  const checkpoint = after.versions.find((version) => version.id === id);
  expect(checkpoint).toMatchObject({ source: "checkpoint", content: kept, parent_version: b });
  expect(await labels(pool)).toEqual([{
    chapter_id: chapterId, version_id: id, series_id: f.seriesId, l_seq: checkpoint.l_seq,
    label: "Before restore", kind: "snapshot", pack_pins: {}, created_at: expect.any(Date),
  }]);
  expect(await lifecycleRows()).toEqual([{
    chapter_id: chapterId, version_id: id, snapshot_id: expect.any(String), state_token: expect.any(String),
    previous_token: null, removed_name_hash: null, removed_created_at: null,
  }]);
  expect(after.ledger.slice(before.ledger.length).map(({ op }) => op))
    .toEqual(["chapter.checkpoint", "chapter.restore"]);
  expect(after.heads).toEqual([]);
  expect(after.active).toEqual(before.active);
});

test("AXB-0116 AC2: no head or an equal head produces no label, while a released Book names its checkpoint", async () => {
  const first = await restore();
  expect(first.checkpoint_version_id).toBeNull();
  expect(await labels(pool)).toEqual([]);
  expect(await lifecycleRows()).toEqual([]);
  await putHead(first.version.id, "The gate shut.");
  const second = await restore();
  expect(second.checkpoint_version_id).toBeNull();
  expect(await labels(pool)).toEqual([]);
  expect(await lifecycleRows()).toEqual([]);

  await pool.query("UPDATE books SET status = 'released' WHERE id = $1", [f.bookId]);
  await putHead(second.version.id);
  const released = await restore();
  expect(released.checkpoint_version_id).toEqual(expect.any(String));
  expect(await labels(pool)).toEqual([expect.objectContaining({
    version_id: released.checkpoint_version_id, label: "Before restore", kind: "snapshot", pack_pins: {},
    l_seq: String(released.version.l_seq - 1),
  })]);
  expect(await lifecycleRows()).toEqual([expect.objectContaining({
    version_id: released.checkpoint_version_id, previous_token: null,
    removed_name_hash: null, removed_created_at: null,
  })]);
});

test("AXB-0116 AC3: scoped 404s write nothing and successive Restores have distinct snapshot IDs", async () => {
  const bobBook = await seedSeries(pool, "usr_bob");
  const other = await f.app.inject({
    method: "POST", url: `/books/${bobBook.bookId}/chapters`, headers: bob,
    payload: { content: "Bob's version." },
  });
  expect(other.statusCode, other.body).toBe(201);
  await putHead();
  const before = await state(pool);
  for (const [chapter, version, headers, message] of [
    [chapterId, a, bob, "Chapter not found"],
    ["ch_000000000000", a, alice, "Chapter not found"],
    [chapterId, other.json().version.id as string, alice, "Version not found"],
  ] as const) {
    const rejected = await requestRestore(chapter, version, headers);
    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toEqual({ error: { code: "not_found", message, details: null } });
  }
  expect(await state(pool)).toEqual(before);
  expect(await labels(pool)).toEqual([]);
  expect(await lifecycleRows()).toEqual([]);

  const first = await restore();
  await putHead(first.version.id, "A different draft head.");
  const second = await restore();
  const checkpoints = [first.checkpoint_version_id, second.checkpoint_version_id].sort();
  expect(checkpoints).toEqual([expect.any(String), expect.any(String)]);
  expect((await labels(pool)).map(({ version_id, label }) => [version_id, label])).toEqual(
    checkpoints.map((id) => [id, "Before restore"]),
  );
  const lifecycles = await lifecycleRows();
  expect(lifecycles.map(({ version_id }) => version_id)).toEqual(checkpoints);
  expect(new Set(lifecycles.map(({ snapshot_id }) => snapshot_id)).size).toBe(2);
});

test("AXB-0116 AC4: History, Remove, Undo and capture reuse share the checkpoint's stored label", async () => {
  await putHead();
  const written = await restore();
  const checkpointId = written.checkpoint_version_id;
  const list = await f.history(chapterId);
  expect(list.statusCode, list.body).toBe(200);
  const { versions } = list.json<ChapterHistory>();
  expect(versions.slice(0, 4).map(({ id }) => id)).toEqual([written.version.id, checkpointId, b, a]);
  const checkpoint = versions[1];
  if (!checkpoint || !checkpoint.snapshot || !checkpoint.snapshot_lifecycle) throw new Error("Missing checkpoint label");
  const snapshot = checkpoint.snapshot;
  const live = checkpoint.snapshot_lifecycle;
  expect(checkpoint.source).toBe("checkpoint");
  expect(checkpoint.can_name_snapshot).toBe(false);
  expect(snapshot).toEqual({
    chapter_id: chapterId, version_id: checkpointId, kind: "snapshot", name: "Before restore",
    l_seq: checkpoint.l_seq, pack_pins: {}, created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  });
  expect(live).toEqual({ snapshot_id: expect.any(String), state_token: expect.any(String), previous_token: null });

  const change = async (action: "remove" | "undo", token: string) => {
    const response = await f.app.inject({
      method: "POST", url: `/chapters/${chapterId}/versions/${checkpointId}/snapshot-label`, headers: alice,
      payload: { action, snapshot_id: live.snapshot_id, expected_token: token, ...(action === "undo" ? { name: snapshot.name } : {}) },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const removed = await change("remove", live.state_token);
  expect(removed).toMatchObject({ snapshot: null, can_name_snapshot: false });
  const undone = await change("undo", removed.snapshot_lifecycle.state_token);
  expect(undone.snapshot).toEqual(snapshot);
  expect(undone.snapshot_lifecycle.snapshot_id).toBe(live.snapshot_id);

  const capture = (name?: string) => f.app.inject({
    method: "POST", url: `/chapters/${chapterId}/snapshots`, headers: alice,
    payload: {
      request_id: randomUUID(), content: kept, base_version: written.version.id, base_revision: 0,
      ...(name === undefined ? {} : { name }),
    },
  });
  const reused = await capture();
  expect(reused.statusCode, reused.body).toBe(201);
  expect(reused.json().capture).toMatchObject({ snapshot, version: { id: checkpointId }, created_version: false });
  const conflict = await capture("Gate");
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toEqual({
    error: { code: "snapshot_conflict", message: "This version already has a snapshot name", details: { reason: "name_exists" } },
  });

  await change("remove", undone.snapshot_lifecycle.state_token);
  const renamed = await capture("Gate");
  expect(renamed.statusCode, renamed.body).toBe(201);
  expect(renamed.json().capture).toMatchObject({
    snapshot: { name: "Gate", version_id: checkpointId }, version: { id: checkpointId }, created_version: false,
  });
  const recovered = await restore(checkpoint.id);
  expect(recovered.checkpoint_version_id).toBeNull();
  const draft = await f.app.inject({ method: "GET", url: `/chapters/${chapterId}`, headers: alice });
  expect(draft.statusCode).toBe(200);
  expect(draft.json().version).toMatchObject({ id: recovered.version.id, source: "restore", content: kept });
  expect(draft.json().active_version_id).toBe(a);
});
