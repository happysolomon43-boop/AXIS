import { afterAll, beforeEach, expect, test } from "vitest";
import { makePool, resetDb } from "./helpers.js";
import { corpusCounts, expectReapplyAll, rollbackAll, seedSeries } from "./seed.js";

const pool = makePool();
const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type CommitResult = { l_seq: number; ids: string[] };

async function commitInputs(
  seriesId: string | null,
  input: unknown,
  op = "chapter.create",
  door: string | null = "corpus",
  actor = "usr_alice",
): Promise<CommitResult> {
  const { rows: [row] } = await pool.query<{ commit_inputs: CommitResult }>(
    "SELECT commit_inputs($1,$2,$3,$4,$5::jsonb)",
    [seriesId, door, actor, op, JSON.stringify(input)],
  );
  if (!row) throw new Error("Commit returned no result");
  return row.commit_inputs;
}

function firstChapter(bookId: string, content = "abc") {
  return [
    { kind: "chapter", book_id: bookId },
    { kind: "chapter_version", chapter_ref: 0, content, source: "draft_edit" },
  ];
}

async function findVersions(ids: string[]) {
  const { rows } = await pool.query<{
    id: string; series_id: string; version_no: number; parent_version: string | null;
    text_hash: string; hints_hash: string; l_seq: number;
  }>(
    `SELECT id, series_id, version_no, parent_version, text_hash, hints_hash, l_seq::int
     FROM chapter_versions WHERE id = ANY($1::text[]) ORDER BY version_no`,
    [ids],
  );
  return rows;
}

async function orderKeys(ids: string[]) {
  const { rows } = await pool.query<{ order_key: string }>(
    "SELECT order_key FROM chapters WHERE id = ANY($1::text[]) ORDER BY order_key", [ids],
  );
  return rows.map(({ order_key }) => order_key);
}

async function ledgerPositions(seriesId: string) {
  const { rows } = await pool.query<{ l_seq: number }>(
    "SELECT l_seq::int FROM ledger WHERE series_id = $1 ORDER BY l_seq", [seriesId],
  );
  return rows.map(({ l_seq }) => l_seq);
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("AC1 commits ordered inputs, version ancestry, active markers, and known hashes", async () => {
  expect((await pool.query("SHOW server_encoding")).rows).toEqual([{ server_encoding: "UTF8" }]);
  const { seriesId, bookId } = await seedSeries(pool);

  const one = await commitInputs(seriesId, firstChapter(bookId));
  expect(one).toEqual({
    l_seq: 1,
    ids: [expect.stringMatching(/^ch_[0-9a-f]{12}$/), expect.stringMatching(/^ver_[0-9a-f]{12}$/)],
  });
  const [c1, v1] = one.ids as [string, string];
  expect(await orderKeys([c1])).toEqual(["0000001000"]);
  expect(await findVersions([v1])).toEqual([{
    id: v1, series_id: seriesId, version_no: 1, parent_version: null,
    text_hash: abcHash, hints_hash: emptyHash, l_seq: 1,
  }]);
  expect((await pool.query(
    "SELECT series_id, l_seq::int, door, actor, op, target_ids FROM ledger",
  )).rows).toEqual([{
    series_id: seriesId, l_seq: 1, door: "corpus", actor: "usr_alice",
    op: "chapter.create", target_ids: [c1, v1],
  }]);

  const two = await commitInputs(seriesId, [
    { kind: "chapter_version", chapter_id: c1, content: "abc  def", source: "send" },
    { kind: "chapter_version", chapter_id: c1, content: " abc def\n", source: "draft_edit" },
  ], "version.add");
  expect(two.l_seq).toBe(2);
  expect(two.ids).toHaveLength(2);
  const [v2, v3] = two.ids as [string, string];
  const twoVersions = await findVersions(two.ids);
  expect(twoVersions).toMatchObject([
    { id: v2, version_no: 2, parent_version: v1, hints_hash: emptyHash, l_seq: 2 },
    { id: v3, version_no: 3, parent_version: v2, hints_hash: emptyHash, l_seq: 2 },
  ]);
  expect(twoVersions[0]?.text_hash).toBe(twoVersions[1]?.text_hash);

  const three = await commitInputs(seriesId, [
    { kind: "chapter_version", chapter_id: c1, content: "x", source: "restore", parent_version: v1 },
  ], "version.add");
  expect(three.l_seq).toBe(3);
  expect(await findVersions(three.ids)).toMatchObject([{ version_no: 4, parent_version: v1, l_seq: 3 }]);

  const four = await commitInputs(seriesId, [
    { kind: "chapter_active", chapter_id: c1, version_id: v2 },
  ], "chapter.send");
  expect(four).toEqual({ l_seq: 4, ids: [c1] });
  expect((await pool.query(
    "SELECT series_id, chapter_id, version_id, since_l::int FROM chapter_active",
  )).rows).toEqual([{ series_id: seriesId, chapter_id: c1, version_id: v2, since_l: 4 }]);

  const five = await commitInputs(seriesId, [
    { kind: "chapter", book_id: bookId },
    { kind: "chapter_version", chapter_ref: 0, content: "q", source: "import" },
    { kind: "chapter_active", chapter_ref: 0, version_ref: 1 },
    { kind: "chapter", book_id: bookId, order_key: "0000500000" },
    { kind: "chapter_active", chapter_id: c1, version_id: null },
  ]);
  expect(five.l_seq).toBe(5);
  const [c2, importedVersion, activeChapter, c3, inactiveChapter] =
    five.ids as [string, string, string, string, string];
  expect(five.ids).toHaveLength(5);
  expect([activeChapter, inactiveChapter]).toEqual([c2, c1]);
  expect(await orderKeys([c2])).toEqual(["0000002000"]);
  expect(await orderKeys([c3])).toEqual(["0000500000"]);
  const { rows: active } = await pool.query(
    "SELECT series_id, chapter_id, version_id, since_l::int FROM chapter_active WHERE since_l = 5",
  );
  expect(active).toHaveLength(2);
  expect(active).toEqual(expect.arrayContaining([
    { series_id: seriesId, chapter_id: c2, version_id: importedVersion, since_l: 5 },
    { series_id: seriesId, chapter_id: c1, version_id: null, since_l: 5 },
  ]));

  const six = await commitInputs(seriesId, firstChapter(bookId, ""));
  expect(six.l_seq).toBe(6);
  const [lastChapter, lastVersion] = six.ids as [string, string];
  expect(await orderKeys([lastChapter])).toEqual(["0000501000"]);
  expect(await findVersions([lastVersion])).toMatchObject([{ text_hash: emptyHash, hints_hash: emptyHash }]);
  expect(await ledgerPositions(seriesId)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("AC2 validates commit requests, rolls back every invalid call, and consumes no position", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const second = await seedSeries(pool, "usr_bob");
  const first = await commitInputs(seriesId, firstChapter(bookId));
  const third = await commitInputs(seriesId, firstChapter(bookId));
  const other = await commitInputs(second.seriesId, firstChapter(second.bookId));
  const [c1, v1] = first.ids as [string, string];
  const [, v3] = third.ids as [string, string];
  const [c2] = other.ids as [string];
  const chapter = { kind: "chapter", book_id: bookId };
  const version = { kind: "chapter_version", content: "abc", source: "draft_edit" };
  const active = { kind: "chapter_active", chapter_id: c1, version_id: v1 };
  const shapeError = "rows must be an array of 1 to 100 objects";
  const baseline = await corpusCounts(pool);

  async function rejects(
    request: Promise<CommitResult>,
    code: string,
    message?: string,
  ): Promise<void> {
    await expect(request).rejects.toMatchObject(message === undefined ? { code } : { code, message });
    expect(await corpusCounts(pool)).toEqual(baseline);
  }

  for (const door of ["writer", null]) {
    await rejects(commitInputs(seriesId, [chapter], "chapter.create", door), "AX002", "door not supported");
  }
  for (const badRows of [[], {}, null, Array.from({ length: 101 }, () => chapter), ["chapter"]]) {
    await rejects(commitInputs(seriesId, badRows), "AX002", shapeError);
  }
  for (const id of ["ser_000000000000", null]) {
    await rejects(commitInputs(id, [chapter]), "AX002", "series not found");
  }

  const invalidCalls: Array<[unknown[], string]> = [
    [[{ kind: "ruling" }], "invalid row"],
    [[{ book_id: bookId }], "invalid row"],
    [[{ ...chapter, title: "Ashfall" }], "invalid row"],
    [[{ kind: "chapter" }], "invalid row"],
    [[{ ...chapter, order_key: "12" }], "invalid row"],
    [[{ ...chapter, order_key: 1000 }], "invalid row"],
    [[{ ...chapter, book_id: second.bookId }], "book not in series"],
    [[{ ...chapter, order_key: "9999999999" }, chapter], "order key space exhausted"],
    [[{ ...version, chapter_id: c1, chapter_ref: 0 }], "invalid row"],
    [[version], "invalid row"],
    [[{ ...version, chapter_ref: 0 }], "invalid reference"],
    [[chapter, { ...version, chapter_ref: 0 }, { ...version, chapter_ref: 1 }], "invalid reference"],
    [[{ ...version, chapter_id: c1, parent_version: v3 }], "invalid parent version"],
    [[chapter, { ...version, chapter_ref: 0, parent_version: v1 }], "invalid parent version"],
    [[{ ...version, chapter_id: c2 }], "chapter not in series"],
    [[{ ...active, version_id: v3 }], "version not in chapter"],
    [[{ kind: "chapter_active", chapter_id: c1 }], "invalid row"],
    [[{ ...active, version_ref: 0 }], "invalid row"],
    [[chapter, { ...version, chapter_ref: 5 }], "invalid reference"],
    [[chapter, { ...version, chapter_ref: -1 }], "invalid reference"],
    [[chapter, { ...version, chapter_ref: 1e50 }], "invalid reference"],
    [[chapter, { ...version, chapter_ref: 0.5 }], "invalid row"],
    [[chapter, { ...version, chapter_ref: 0 },
      { kind: "chapter_active", chapter_ref: 0, version_ref: 0 }], "invalid reference"],
  ];
  for (const [rows, message] of invalidCalls) {
    await rejects(commitInputs(seriesId, rows), "AX002", message);
  }
  await rejects(commitInputs(seriesId, [{ ...version, chapter_id: c1, source: "bogus" }]), "22P02");
  await rejects(commitInputs(seriesId, [{ ...version, chapter_id: c1, content: "a".repeat(1000001) }]), "23514");
  await rejects(commitInputs(seriesId, [active, active]), "23505");
  await rejects(commitInputs(seriesId, firstChapter(bookId), "chapter.create", "corpus", "alice"), "23514");
  await rejects(commitInputs(seriesId, firstChapter(bookId), "Bad Op"), "23514");

  const whitespace = String.fromCodePoint(
    9, 10, 11, 12, 13, 32, 133, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288,
  );
  const recovered = await commitInputs(seriesId, firstChapter(bookId, whitespace));
  expect(recovered.l_seq).toBe(third.l_seq + 1);
  expect(await findVersions(recovered.ids)).toMatchObject([{ text_hash: emptyHash, hints_hash: emptyHash }]);
});

test("AC3 parallel commits and version writes have contiguous positions, keys, and parents", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const created = await Promise.all(
    Array.from({ length: 10 }, (_, index) => commitInputs(seriesId, firstChapter(bookId, `c${index}`))),
  );
  const positions = Array.from({ length: 10 }, (_, index) => index + 1);
  expect(created.map(({ l_seq }) => l_seq).sort((a, b) => a - b)).toEqual(positions);
  expect(await ledgerPositions(seriesId)).toEqual(positions);

  const { rows: chapters } = await pool.query<{ id: string; order_key: string }>(
    "SELECT id, order_key FROM chapters WHERE book_id = $1 ORDER BY order_key", [bookId],
  );
  expect(chapters.map(({ order_key }) => order_key)).toEqual(
    positions.map((position) => String(position * 1000).padStart(10, "0")),
  );
  expect((await findVersions(created.flatMap(({ ids }) => ids))).map(({ version_no }) => version_no))
    .toEqual(Array.from({ length: 10 }, () => 1));

  const firstChapterId = chapters[0]!.id;
  const added = await Promise.all(Array.from({ length: 5 }, (_, index) => commitInputs(seriesId, [
    { kind: "chapter_version", chapter_id: firstChapterId, content: `v${index}`, source: "draft_edit" },
  ], "version.add")));
  expect(added.map(({ l_seq }) => l_seq).sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15]);

  const { rows: versions } = await pool.query<{ id: string; version_no: number; parent_version: string | null }>(
    `SELECT id, version_no, parent_version FROM chapter_versions
     WHERE chapter_id = $1 ORDER BY version_no`, [firstChapterId],
  );
  expect(versions.map(({ version_no }) => version_no)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(versions.map(({ parent_version }) => parent_version))
    .toEqual([null, ...versions.slice(0, -1).map(({ id }) => id)]);
});

test("AC4 removes and restores commit_inputs with the full migration chain", async () => {
  await rollbackAll(pool);
  expect((await pool.query(
    "SELECT to_regprocedure('commit_inputs(text,text,text,text,jsonb)') AS commit_function",
  )).rows).toEqual([{ commit_function: null }]);

  await expectReapplyAll(pool);
  const { seriesId, bookId } = await seedSeries(pool);
  expect((await commitInputs(seriesId, firstChapter(bookId))).l_seq).toBe(1);
});
