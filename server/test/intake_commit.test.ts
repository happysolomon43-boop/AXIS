import { afterAll, beforeEach, expect, test } from "vitest";
import type { BlockRow, SceneRow } from "../src/corpus/repo.js";
import { makePool, resetDb } from "./helpers.js";
import {
  abcHash, emptyHash, expectReapplyAll, helloHash, intakeCounts, rollbackAll,
  seedSeries, seedVersion, story, storyBlocks, storyScenes,
} from "./seed.js";

const pool = makePool();
const three = "A\n\n---\n\nB\n\n---\n\nC";
const defaults = { pov_hint: null, location_hint: null, time_hint: null, time_mode: "linear" };
const uidPattern = /^b_[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;

async function commit(seriesId: string, input: object[], op = "chapter.create") {
  const { rows: [row] } = await pool.query<{ commit_inputs: { l_seq: number; ids: string[] } }>(
    "SELECT commit_inputs($1,'corpus','usr_alice',$2,$3::jsonb)",
    [seriesId, op, JSON.stringify(input)],
  );
  if (!row) throw new Error("Commit returned no result");
  return row.commit_inputs;
}

function chapterRows(bookId: string, content: string, hints?: unknown, chapterRef = 0) {
  return [
    { kind: "chapter", book_id: bookId },
    { kind: "chapter_version", chapter_ref: chapterRef, content, source: "draft_edit", hints },
  ];
}

function versionRow(chapterId: string, content: string, parentVersion?: string) {
  return {
    kind: "chapter_version", chapter_id: chapterId, content,
    source: "draft_edit", parent_version: parentVersion,
  };
}

async function create(seriesId: string, bookId: string, content: string, hints?: unknown) {
  const committed = await commit(seriesId, chapterRows(bookId, content, hints));
  const [chapterId, versionId] = committed.ids as [string, string];
  return { chapterId, versionId, lSeq: committed.l_seq };
}

async function append(seriesId: string, chapterId: string, content: string, parentVersion?: string) {
  const result = await commit(seriesId, [versionRow(chapterId, content, parentVersion)], "version.add");
  return result.ids[0]!;
}

async function blocks(versionId: string) {
  const { rows } = await pool.query<BlockRow>(
    "SELECT block_uid, ordinal, kind, text, hash FROM blocks WHERE version_id = $1 ORDER BY ordinal",
    [versionId],
  );
  return rows;
}

async function scenes(versionId: string) {
  const { rows } = await pool.query<SceneRow>(
    `SELECT ordinal, fingerprint, first_block, last_block, pov_hint, location_hint, time_hint, time_mode
     FROM scenes WHERE version_id = $1 ORDER BY ordinal`, [versionId],
  );
  return rows;
}

async function versionHashes(versionId: string) {
  const { rows: [row] } = await pool.query<{ text_hash: string; hints_hash: string }>(
    "SELECT text_hash, hints_hash FROM chapter_versions WHERE id = $1", [versionId],
  );
  return row;
}

async function uids(versionId: string) {
  return (await blocks(versionId)).map(({ block_uid }) => block_uid);
}

async function fingerprints(versionId: string) {
  return (await scenes(versionId)).map(({ fingerprint }) => fingerprint);
}

async function seedLegacyChild(
  seriesId: string, chapterId: string, parentId: string, versionNo: number, content: string,
): Promise<string> {
  const { rows: [row] } = await pool.query<{ id: string }>(
    `WITH committed AS (
       INSERT INTO ledger (series_id, l_seq, door, actor, op, target_ids)
       VALUES ($1, $3, 'corpus', 'usr_alice', 'version.add', ARRAY[$2::text]) RETURNING l_seq
     )
     INSERT INTO chapter_versions
       (series_id, chapter_id, version_no, source, content, text_hash, hints_hash, parent_version, l_seq)
     SELECT $1, $2, $3::integer, 'draft_edit', $4, repeat('a', 64), repeat('b', 64), $5, l_seq
     FROM committed RETURNING id`,
    [seriesId, chapterId, versionNo, content, parentId],
  );
  if (!row) throw new Error("Legacy version seed returned no row");
  return row.id;
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("AC1 stores blocks, ranges, and known hashes for text and empty versions", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const contents = ["abc", story, "", " \n\t ", "hello"];
  const { ids } = await commit(seriesId, contents.flatMap((content, index) =>
    chapterRows(bookId, content, undefined, index * 2),
  ));
  expect(ids).toEqual(contents.flatMap(() => [
    expect.stringMatching(/^ch_[0-9a-f]{12}$/), expect.stringMatching(/^ver_[0-9a-f]{12}$/),
  ]));
  const [, abcId, , storyId, , emptyId, , whitespaceId, , helloId] =
    ids as [string, string, string, string, string, string, string, string, string, string];

  expect(await blocks(abcId)).toEqual([
    { block_uid: expect.stringMatching(uidPattern), ordinal: 1, kind: "paragraph", text: "abc", hash: abcHash },
  ]);
  expect(await scenes(abcId)).toEqual([
    { ordinal: 1, first_block: 1, last_block: 1, fingerprint: abcHash, ...defaults },
  ]);
  expect(await versionHashes(abcId)).toEqual({ text_hash: abcHash, hints_hash: emptyHash });

  expect(await blocks(storyId)).toEqual(storyBlocks.map(({ ordinal, kind, text }) => ({
    ordinal, kind, text, block_uid: expect.stringMatching(uidPattern), hash: expect.stringMatching(hashPattern),
  })));
  const storedScenes = await scenes(storyId);
  expect(storedScenes).toEqual(storyScenes.map((scene) => ({
    ...scene, ...defaults, fingerprint: expect.stringMatching(hashPattern),
  })));
  expect(new Set(storedScenes.map(({ fingerprint }) => fingerprint)).size).toBe(3);

  for (const versionId of [emptyId, whitespaceId]) {
    expect(await blocks(versionId)).toEqual([]);
    expect(await scenes(versionId)).toEqual([]);
    expect(await versionHashes(versionId)).toEqual({ text_hash: emptyHash, hints_hash: emptyHash });
  }
  expect((await blocks(helloId)).map(({ hash }) => hash)).toEqual([helloHash]);
  expect(await fingerprints(helloId)).toEqual([helloHash]);
});

test("AC2 pairs UIDs by block kind, folded hash, ordinal rank, and explicit parent", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const first = await create(seriesId, bookId, "alpha\n\nbeta\n\ngamma");
  const [u1, u2, u3] = await uids(first.versionId);
  expect(new Set([u1, u2, u3]).size).toBe(3);
  const second = await append(seriesId, first.chapterId, "gamma\n\nalpha\n\nnew\n\nbeta");
  const secondUids = await uids(second);
  const n1 = secondUids[2];
  expect(secondUids).toEqual([u3, u1, expect.stringMatching(uidPattern), u2]);
  expect([u1, u2, u3]).not.toContain(n1);

  const third = await append(seriesId, first.chapterId, "alpha\n\nalpha\n\nbeta");
  const thirdUids = await uids(third);
  expect(thirdUids).toEqual([u1, expect.stringMatching(uidPattern), u2]);
  expect([u1, u2, u3, n1]).not.toContain(thirdUids[1]);

  const restored = await append(seriesId, first.chapterId, "beta\n\ngamma", first.versionId);
  expect(await uids(restored)).toEqual([u2, u3]);

  const mixed = await create(seriesId, bookId, "one two\n\n# one two");
  const mixedNew = await append(seriesId, mixed.chapterId, "one   two\n\n## one two");
  expect(await uids(mixedNew)).toEqual(await uids(mixed.versionId));
  const flipped = await append(seriesId, mixed.chapterId, "# one two\n\none   two");
  expect(await uids(flipped)).toEqual((await uids(mixed.versionId)).reverse());

  const straight = await create(seriesId, bookId, 'He said "hi."');
  const curved = await append(seriesId, straight.chapterId, "He said “hi.”");
  expect(await uids(curved)).not.toEqual(await uids(straight.versionId));

  const duplicate = await create(seriesId, bookId, "x\n\nx\n\nx");
  const baseUids = await uids(duplicate.versionId);
  const grown = await append(seriesId, duplicate.chapterId, "x\n\nx\n\nx\n\nx");
  const grownUids = await uids(grown);
  expect(grownUids).toEqual([...baseUids, expect.stringMatching(uidPattern)]);
  expect(baseUids).not.toContain(grownUids[3]);
  const shrunk = await append(seriesId, duplicate.chapterId, "x\n\nx", duplicate.versionId);
  expect(await uids(shrunk)).toEqual(baseUids.slice(0, 2));

  const other = await create(seriesId, bookId, "alpha");
  expect(await uids(other.versionId)).not.toEqual([u1]);

  const sameCommit = await commit(seriesId, [
    versionRow(other.chapterId, "p\n\nq"),
    versionRow(other.chapterId, "q\n\np"),
  ], "version.add");
  const [pThenQ, qThenP] = sameCommit.ids as [string, string];
  expect(await uids(qThenP)).toEqual((await uids(pThenQ)).reverse());
});

test("AC3 hashes canonical hints and fingerprints only normalized block sentence text", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const hints = [{ pov: "Lyra", time_mode: "flashback" }, null, { location: "Harbor City", time: "March 2018" }];
  const hinted = await create(seriesId, bookId, three, hints);
  const unhinted = await create(seriesId, bookId, three);
  const range = [
    { ordinal: 1, first_block: 1, last_block: 1, ...defaults, pov_hint: "Lyra", time_mode: "flashback" },
    { ordinal: 2, first_block: 3, last_block: 3, ...defaults },
    { ordinal: 3, first_block: 5, last_block: 5, ...defaults, location_hint: "Harbor City", time_hint: "March 2018" },
  ];
  const expectedFingerprints = await fingerprints(unhinted.versionId);
  expect(await scenes(hinted.versionId)).toEqual(
    range.map((scene, index) => ({ ...scene, fingerprint: expectedFingerprints[index] })),
  );

  const canonical = '[1, "Lyra", null, null, "flashback"]\n[3, null, "Harbor City", "March 2018", "linear"]\n';
  const { rows: [expectedHash] } = await pool.query<{ hash: string }>(
    "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS hash", [canonical],
  );
  expect((await versionHashes(hinted.versionId))?.hints_hash).toBe(expectedHash?.hash);

  async function hintsHash(value: unknown) {
    const { versionId } = await create(seriesId, bookId, three, value);
    return (await versionHashes(versionId))?.hints_hash;
  }

  for (const value of [undefined, [], null, [null, {}, { time_mode: "linear" }]]) {
    expect(await hintsHash(value)).toBe(emptyHash);
  }
  const lyra = await hintsHash([{ pov: "Lyra" }]);
  expect(lyra).toMatch(hashPattern);
  expect(await hintsHash([{ pov: "Lyra", time_mode: "linear" }])).toBe(lyra);
  expect(await hintsHash([{ pov: "Ilsa" }])).not.toBe(lyra);
  expect(await hintsHash([null, { pov: "Lyra" }])).not.toBe(lyra);

  async function fingerprint(content: string) {
    return (await fingerprints((await create(seriesId, bookId, content)).versionId))[0];
  }

  const curved = await fingerprint("He said “hi.”");
  expect(curved).toMatch(hashPattern);
  expect(await fingerprint('He said "hi."')).toBe(curved);
  expect(await fingerprint('He  said\n"hi."')).toBe(curved);
  expect(await fingerprint("a\n\nb")).not.toBe(await fingerprint("a b"));
  expect(await fingerprint("# abc")).toBe(abcHash);
  expect(await fingerprint("abc")).toBe(abcHash);
});

test("AC4 rejects invalid commits atomically and processes large valid inputs", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const initial = await create(seriesId, bookId, "abc");
  const before = await intakeCounts(pool);

  async function reject(rows: object[], code: string, message?: string) {
    await expect(commit(seriesId, rows)).rejects.toMatchObject(message === undefined ? { code } : { code, message });
    expect(await intakeCounts(pool)).toEqual(before);
  }

  for (const hints of [{}, "Lyra", 1]) {
    await reject(chapterRows(bookId, three, hints), "AX002", "invalid row");
  }
  for (const hints of [
    ["Lyra"], [{ mood: "calm" }], [{ pov: "" }], [{ pov: "a".repeat(201) }],
    [{ time_mode: "sideways" }], [{ time_mode: 1 }], [null, null, null, null],
  ]) {
    await reject(chapterRows(bookId, three, hints), "AX002", "invalid hints");
  }
  await reject(chapterRows(bookId, "", [null]), "AX002", "invalid hints");
  await reject([
    versionRow(initial.chapterId, "hello"),
    { ...versionRow(initial.chapterId, ""), hints: [null] },
  ], "AX002", "invalid hints");
  await reject(chapterRows(bookId, "a".repeat(1000001)), "23514");
  await reject([{ ...versionRow(initial.chapterId, "abc"), source: "bogus" }], "22P02");
  await expect(pool.query("SELECT axis_hints_hash('{}'::jsonb)"))
    .rejects.toMatchObject({ code: "AX002", message: "invalid hints" });
  await expect(pool.query("SELECT axis_intake_store('ver_000000000000', NULL)"))
    .rejects.toMatchObject({ code: "AX002", message: "version not found" });

  const aMil = await create(seriesId, bookId, "a".repeat(1000000));
  expect(aMil.lSeq).toBe(initial.lSeq + 1);
  const { rows: sizes } = await pool.query(
    `SELECT char_length(text) AS chars FROM blocks WHERE version_id = $1`, [aMil.versionId],
  );
  expect(sizes).toEqual([{ chars: 1000000 }]);
  expect(await scenes(aMil.versionId)).toHaveLength(1);

  const emoji = await create(seriesId, bookId, "😀".repeat(600000));
  expect((await pool.query(
    "SELECT char_length(text) AS chars FROM blocks WHERE version_id = $1", [emoji.versionId],
  )).rows).toEqual([{ chars: 600000 }]);

  const large = Array.from({ length: 20000 }, (_, index) => "p" + String(index).padStart(5, "0")).join("\n\n");
  const old = await create(seriesId, bookId, large);
  expect((await pool.query(
    "SELECT count(*)::int AS count FROM blocks WHERE version_id = $1", [old.versionId],
  )).rows).toEqual([{ count: 20000 }]);
  expect(await scenes(old.versionId)).toHaveLength(1);

  const edited = await append(seriesId, old.chapterId, large.replace("p10000", "changed"));
  const { rows: pairs } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE n.text = p.text AND n.block_uid = p.block_uid)::int AS stable,
            count(*) FILTER (WHERE n.text = 'changed' AND NOT EXISTS (
              SELECT 1 FROM blocks AS prior WHERE prior.version_id = $1 AND prior.block_uid = n.block_uid
            ))::int AS fresh
     FROM blocks AS n LEFT JOIN blocks AS p ON p.version_id = $1 AND p.ordinal = n.ordinal
     WHERE n.version_id = $2`,
    [old.versionId, edited],
  );
  expect(pairs).toEqual([{ total: 20000, stable: 19999, fresh: 1 }]);
  expect(await scenes(edited)).toHaveLength(1);
}, 60_000);

test("AC5 orders concurrent intake, backfills legacy parents once, and survives rollback", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) => create(seriesId, bookId, `c${i}`)));
  const added = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    commit(seriesId, [versionRow(first[0]!.chapterId, `v${i}`)], "version.add"),
  ));
  const addedIds = added.flatMap(({ ids }) => ids);
  const expectedPositions = Array.from({ length: 15 }, (_, i) => i + 1);
  expect([...first.map(({ lSeq }) => lSeq), ...added.map(({ l_seq }) => l_seq)].sort((a, b) => a - b))
    .toEqual(expectedPositions);
  expect((await pool.query(
    "SELECT l_seq::int FROM ledger WHERE series_id = $1 ORDER BY l_seq", [seriesId],
  )).rows).toEqual(expectedPositions.map((l_seq) => ({ l_seq })));

  for (const versionId of [...first.map(({ versionId }) => versionId), ...addedIds]) {
    expect(await blocks(versionId)).toHaveLength(1);
    expect(await scenes(versionId)).toHaveLength(1);
  }
  const addedUids = await Promise.all(addedIds.map(uids));
  expect(new Set(addedUids.flat()).size).toBe(5);

  const legacy = await seedSeries(pool);
  const v1 = await seedVersion(pool, legacy.seriesId, legacy.bookId, "alpha\n\nbeta");
  const v2 = await seedLegacyChild(legacy.seriesId, v1.chapterId, v1.versionId, 2, "beta\n\nalpha\n\ngamma");
  const v3 = await seedLegacyChild(legacy.seriesId, v1.chapterId, v2, 3, "");
  expect((await pool.query("SELECT axis_intake_backfill() AS processed")).rows).toEqual([{ processed: 2 }]);
  const [alpha, beta] = await uids(v1.versionId);
  expect(await uids(v2)).toEqual([beta, alpha, expect.stringMatching(uidPattern)]);
  expect(await blocks(v3)).toEqual([]);
  expect(await scenes(v3)).toEqual([]);
  expect((await pool.query("SELECT axis_intake_backfill() AS processed")).rows).toEqual([{ processed: 0 }]);

  await rollbackAll(pool);
  await expectReapplyAll(pool);
  const reapplied = await seedSeries(pool);
  const restored = await create(reapplied.seriesId, reapplied.bookId, "abc");
  expect(restored.lSeq).toBe(1);
  expect(await blocks(restored.versionId)).toHaveLength(1);
  expect(await scenes(restored.versionId)).toHaveLength(1);
});
