import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  createChapterWithFirstVersion, type ChapterCreated, type ChapterDetail, type ChapterHistory, type VersionWritten,
} from "../src/corpus/repo.js";
import type { VersionText } from "../src/versions/repository.js";
import type { RestoreWritten } from "../src/versions/restore.js";
import { makePool, resetDb } from "./helpers.js";
import { emptyHash, intakeCounts, seedSeries } from "./seed.js";

const pool = makePool();
const apiPool = { query: pool.query.bind(pool), connect: vi.fn(() => pool.connect()) };
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
const initial = "# Title\n\nOne\n\n---\n\nTwo";
const revised = "# Title\n\nOne!\n\n---\n\nTwo";
const sent = "# Title\n\nThree";
let book: { id: string; series_id: string };
let app: FastifyInstance;
let first: ChapterCreated;
let second: VersionWritten;
let third: VersionWritten;
let path: string;

beforeEach(async () => {
  await resetDb(pool);
  const { bookId, seriesId } = await seedSeries(pool);
  await seedSeries(pool, "usr_bob");
  book = { id: bookId, series_id: seriesId };
  first = await createChapterWithFirstVersion(pool, "usr_alice", book, initial, "draft_edit");
  path = `/chapters/${first.chapter.id}`;
  apiPool.connect.mockClear();
  app = buildApp({ pool: apiPool as unknown as Pool });
  second = await write<VersionWritten>("POST", `${path}/versions`, {
    content: revised, parent_version: first.version.id, hints: [{ pov: "Lyra", time_mode: "flashback" }],
  });
  third = await write<VersionWritten>("POST", `${path}/send`, {
    content: sent, parent_version: second.version.id,
  });
});

afterEach(() => app.close());
afterAll(() => pool.end());

async function write<T>(method: "POST" | "PUT", url: string, payload: object): Promise<T> {
  const response = await app.inject({ method, url, headers: alice, payload });
  expect(response.statusCode, response.body).toBe(method === "PUT" ? 200 : 201);
  return response.json<T>();
}

async function read<T>(suffix = ""): Promise<T> {
  const response = await app.inject({ method: "GET", url: path + suffix, headers: alice });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function restore(version_id: string) {
  return write<RestoreWritten>("POST", `${path}/restore`, { version_id });
}

function putHead(content: string, base_version = third.version.id) {
  return write("PUT", `${path}/draft`, { content, base_version, base_revision: 0 });
}

async function ledgerAfter(lSeq: number) {
  const { rows } = await pool.query(
    "SELECT l_seq::int, op, door, actor FROM ledger WHERE series_id = $1 AND l_seq > $2 ORDER BY l_seq",
    [book.series_id, lSeq],
  );
  return rows;
}

async function existingRows() {
  const ids = [first.version.id, second.version.id, third.version.id];
  const [versions, blocks, scenes, active] = await Promise.all([
    pool.query("SELECT * FROM chapter_versions WHERE id = ANY($1::text[]) ORDER BY id", [ids]),
    pool.query("SELECT * FROM blocks WHERE version_id = ANY($1::text[]) ORDER BY version_id, ordinal", [ids]),
    pool.query("SELECT * FROM scenes WHERE version_id = ANY($1::text[]) ORDER BY version_id, ordinal", [ids]),
    pool.query("SELECT * FROM chapter_active ORDER BY chapter_id, since_l"),
  ]);
  return [versions.rows, blocks.rows, scenes.rows, active.rows];
}

test("AC1 copies text and hints without a head or any change to the active or earlier rows", async () => {
  const before = await existingRows();
  const { versions } = await read<ChapterHistory>("/history");
  const source = versions.find(({ id }) => id === second.version.id);
  if (!source) throw new Error("The seeded source is missing from history");
  const written = await restore(second.version.id);
  expect(written).toEqual({
    chapter: { id: first.chapter.id, book_id: book.id, order_key: "0000001000" },
    version: {
      id: expect.stringMatching(/^ver_[0-9a-f]{12}$/), chapter_id: first.chapter.id, version_no: 4,
      source: "restore", text_hash: source.text_hash, hints_hash: source.hints_hash,
      parent_version: third.version.id, l_seq: third.version.l_seq + 1,
    },
    active_version_id: third.version.id, checkpoint_version_id: null,
  });
  expect(written.version.hints_hash).not.toBe(emptyHash);

  const detail = await read<ChapterDetail>();
  expect(detail.version).toEqual({ ...written.version, content: revised });
  expect(detail.active_version_id).toBe(third.version.id);
  expect(detail.scenes).toMatchObject([
    { pov_hint: "Lyra", time_mode: "flashback" }, { pov_hint: null, time_mode: "linear" },
  ]);
  expect((await read<VersionText>(`/versions/${written.version.id}`)).blocks).toEqual([
    { ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "One!" },
    { ordinal: 3, kind: "scene_break", text: "---" }, { ordinal: 4, kind: "paragraph", text: "Two" },
  ]);
  expect((await read<ChapterHistory>("/history")).versions.map(({ source }) => source)).toEqual([
    "restore", "send", "draft_edit", "draft_edit",
  ]);
  expect(await ledgerAfter(third.version.l_seq)).toEqual([
    { l_seq: written.version.l_seq, op: "chapter.restore", door: "corpus", actor: "usr_alice" },
  ]);
  expect(await existingRows()).toEqual(before);
});

test("AC2 checkpoints a different head and restores from the checkpoint parent in the same transaction", async () => {
  const before = await existingRows();
  await putHead("# Title\n\nThree!!");
  const written = await restore(first.version.id);
  expect(written.checkpoint_version_id).toEqual(expect.any(String));
  expect(written.active_version_id).toBe(third.version.id);
  expect(written.version).toMatchObject({
    version_no: 5, source: "restore", parent_version: written.checkpoint_version_id,
    text_hash: first.version.text_hash, hints_hash: emptyHash,
  });
  const checkpoint = await read<VersionText>(`/versions/${written.checkpoint_version_id}`);
  expect(checkpoint.version).toMatchObject({
    id: written.checkpoint_version_id, version_no: 4, source: "checkpoint", parent_version: third.version.id,
  });
  expect(checkpoint.blocks).toEqual([
    { ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "Three!!" },
  ]);
  expect(await read("/draft")).toEqual({ chapter: first.chapter, draft: null, sync: { state: "edited", same: false } });
  expect(await ledgerAfter(third.version.l_seq)).toEqual([
    { l_seq: third.version.l_seq + 1, op: "chapter.checkpoint", door: "corpus", actor: "usr_alice" },
    { l_seq: third.version.l_seq + 2, op: "chapter.restore", door: "corpus", actor: "usr_alice" },
  ]);
  expect(written.version.l_seq).toBe(third.version.l_seq + 2);
  expect(await existingRows()).toEqual(before);
});

test("AC3 skips equal heads, restores newest and empty versions, and serializes concurrent restores", async () => {
  await putHead(sent);
  const fourth = await restore(first.version.id);
  expect(fourth.checkpoint_version_id).toBeNull();
  expect(fourth.version).toMatchObject({ version_no: 4, parent_version: third.version.id });
  expect(await read("/draft")).toEqual({ chapter: first.chapter, draft: null, sync: { state: "edited", same: false } });
  expect(await ledgerAfter(third.version.l_seq)).toHaveLength(1);

  const fifth = await restore(fourth.version.id);
  expect(fifth.version).toMatchObject({
    version_no: 5, text_hash: fourth.version.text_hash, parent_version: fourth.version.id,
  });
  const parallel = await Promise.all([restore(first.version.id), restore(second.version.id)]);
  const [sixth, seventh] = parallel.map(({ version }) => version).sort((a, b) => a.version_no - b.version_no);
  if (!sixth || !seventh) throw new Error("A concurrent restore returned no version");
  expect(sixth.version_no).toBe(6);
  expect(seventh).toMatchObject({ version_no: 7, parent_version: sixth.id });

  const empty = await write<VersionWritten>("POST", `${path}/versions`, { content: "" });
  await putHead(" ", empty.version.id);
  const restoredEmpty = await restore(empty.version.id);
  expect(restoredEmpty.checkpoint_version_id).toEqual(expect.any(String));
  const checkpoint = await read<VersionText>(`/versions/${restoredEmpty.checkpoint_version_id}`);
  expect(checkpoint.version.text_hash).toBe(emptyHash);
  expect(restoredEmpty.version).toMatchObject({ text_hash: emptyHash, hints_hash: emptyHash, version_no: 10 });
  expect((await read<VersionText>(`/versions/${restoredEmpty.version.id}`)).blocks).toEqual([]);
});

test("AC4 applies validation and ownership in order and rolls back every write on failure", async () => {
  const other = await createChapterWithFirstVersion(pool, "usr_alice", book, "Other", "draft_edit");
  await putHead("# Title\n\nThree!!");
  const before = await intakeCounts(pool);
  const head = await read("/draft");
  const valid = { version_id: first.version.id };
  const missingVersion = ["not_found", "Version not found"] as const;
  const missingChapter = ["not_found", "Chapter not found"] as const;
  const invalidBody = ["validation_failed", "Request validation failed"] as const;
  apiPool.connect.mockClear();

  for (const [url, headers, payload, status, [code, message]] of [
    [path, { "content-type": "text/plain" }, "invalid", 401,
      ["auth_required", "Missing or invalid X-Axis-User header"]],
    [path, bob, valid, 404, missingChapter],
    [path, bob, { version_id: "ver_\u0000" }, 404, missingChapter],
    ["/chapters/ch_000000000000", alice, valid, 404, missingChapter],
    [path, alice, { version_id: "ver_\u0000" }, 404, missingVersion],
    [path, alice, {}, 400, invalidBody],
    [path, alice, { version_id: "" }, 400, invalidBody],
    [path, alice, { version_id: 42 }, 400, invalidBody],
    [path, alice, { version_id: "v".repeat(65) }, 400, invalidBody],
    [path, alice, { version_id: "x", extra: 1 }, 400, invalidBody],
    [path, { ...alice, "content-type": "text/plain" }, "bad", 415,
      ["unsupported_media_type", "Content-Type must be application/json"]],
    [`/chapters/${"c".repeat(101)}`, alice, valid, 404, ["not_found", "Route not found"]],
  ] as const) {
    const response = await app.inject({ method: "POST", url: `${url}/restore`, headers, payload });
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toEqual({
      error: { code, message, details: status === 400 ? { errors: expect.any(Array) } : null },
    });
  }
  expect(apiPool.connect).not.toHaveBeenCalled();
  for (const version_id of ["ver_000000000000", other.version.id]) {
    const response = await app.inject({ method: "POST", url: `${path}/restore`, headers: alice, payload: { version_id } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: missingVersion[0], message: missingVersion[1], details: null } });
  }
  expect(await intakeCounts(pool)).toEqual(before);
  expect(await read("/draft")).toEqual(head);

  await pool.query(`
    CREATE FUNCTION reject_restore_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source = 'restore' THEN RAISE EXCEPTION 'test failed restore'; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_restore_for_test BEFORE INSERT ON chapter_versions
      FOR EACH ROW EXECUTE FUNCTION reject_restore_for_test()
  `);
  try {
    const response = await app.inject({ method: "POST", url: `${path}/restore`, headers: alice, payload: valid });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
    expect(await intakeCounts(pool)).toEqual(before);
    expect(await read("/draft")).toEqual(head);
    expect(await ledgerAfter(third.version.l_seq)).toEqual([
      { l_seq: other.version.l_seq, op: "chapter.create", door: "corpus", actor: "usr_alice" },
    ]);
  } finally {
    await pool.query("DROP FUNCTION reject_restore_for_test() CASCADE");
  }
});
