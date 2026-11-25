import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated } from "../src/corpus/repo.js";
import type { SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { corpusCounts } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice", "content-type": "application/json" };
const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const input = [
  { content: "abc" },
  { content: "  abc\n", source: "import" },
  { content: "" },
  { content: "a".repeat(1000000) },
  { content: "😀".repeat(600000) },
];
let app: FastifyInstance;
let bookId: string;
let seriesId: string;

beforeEach(async () => {
  await resetDb(pool);
  app = buildApp({ pool });
  const response = await app.inject({
    method: "POST", url: "/series", headers: alice, payload: { title: "Ashfall" },
  });
  expect(response.statusCode).toBe(201);
  const { series, books } = response.json<SeriesTree>();
  seriesId = series.id;
  bookId = books[0]!.id;
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

function post(
  payload: object | string,
  id = bookId,
  headers: Record<string, string> = alice,
) {
  return app.inject({ method: "POST", url: `/books/${id}/chapters`, headers, payload });
}

async function create(payload: object): Promise<ChapterCreated> {
  const response = await post(payload);
  expect(response.statusCode).toBe(201);
  return response.json<ChapterCreated>();
}

async function ledgerRows() {
  return (await pool.query(
    "SELECT series_id, l_seq::int, door, actor, op, target_ids FROM ledger ORDER BY l_seq",
  )).rows;
}

test("AC1 creates first versions with contiguous chapter order and Unicode limits", async () => {
  const first = await create(input[0]!);
  expect(first).toEqual({
    chapter: {
      id: expect.stringMatching(/^ch_[0-9a-f]{12}$/), book_id: bookId, order_key: "0000001000",
    },
    version: {
      id: expect.stringMatching(/^ver_[0-9a-f]{12}$/), chapter_id: first.chapter.id,
      version_no: 1, source: "draft_edit", text_hash: abcHash, hints_hash: emptyHash,
      parent_version: null, l_seq: 1,
    },
  });
  expect(await corpusCounts(pool)).toEqual({ ledger: 1, chapters: 1, versions: 1, active: 0 });
  expect((await pool.query("SELECT content FROM chapter_versions")).rows).toEqual([{ content: "abc" }]);
  expect(await ledgerRows()).toEqual([{
    series_id: seriesId, l_seq: 1, door: "corpus", actor: "usr_alice", op: "chapter.create",
    target_ids: [first.chapter.id, first.version.id],
  }]);

  const second = await create(input[1]!);
  expect(second.chapter).toMatchObject({ book_id: bookId, order_key: "0000002000" });
  expect(second.chapter.id).not.toBe(first.chapter.id);
  expect(second.version).toMatchObject({ l_seq: 2, source: "import", text_hash: abcHash });

  const third = await create(input[2]!);
  expect(third.chapter.order_key).toBe("0000003000");
  expect(third.version).toMatchObject({ l_seq: 3, text_hash: emptyHash });
  expect((await create(input[3]!)).version.l_seq).toBe(4);
  expect((await create(input[4]!)).version.l_seq).toBe(5);
  expect(await corpusCounts(pool)).toEqual({ ledger: 5, chapters: 5, versions: 5, active: 0 });
});

test("AC2 rejects wrong identity, invalid Books, payloads, and content without writing", async () => {
  for (const payload of input) await create(payload);
  const before = await ledgerRows();

  const noIdentity = await post("{bad", bookId, { "content-type": "application/json" });
  expect(noIdentity.statusCode).toBe(401);
  expect(noIdentity.json()).toEqual({
    error: { code: "auth_required", message: "Missing or invalid X-Axis-User header", details: null },
  });

  for (const [id, headers] of [
    [bookId, { ...alice, "x-axis-user": "usr_bob" }],
    ["bk_000000000000", alice],
    ["not-an-id", alice],
    ["%00", alice],
    ["a".repeat(65), alice],
    ["a".repeat(100), alice],
  ] as const) {
    const response = await post({ content: "abc" }, id, headers);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "not_found", message: "Book not found", details: null },
    });
  }

  const longId = await post("{bad", "a".repeat(101));
  expect(longId.statusCode).toBe(404);
  expect(longId.json()).toEqual({
    error: { code: "not_found", message: "Route not found", details: null },
  });

  const unsupported = await post('{"content":"abc"}', bookId, { ...alice, "content-type": "text/plain" });
  expect(unsupported.statusCode).toBe(415);
  expect(unsupported.json()).toEqual({
    error: { code: "unsupported_media_type", message: "Content-Type must be application/json", details: null },
  });

  const malformed = await post("{bad");
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json()).toEqual({
    error: { code: "validation_failed", message: "Request could not be parsed", details: null },
  });

  const oversized = await post(" ".repeat(8388609));
  expect(oversized.statusCode).toBe(413);
  expect(oversized.json()).toEqual({
    error: { code: "payload_too_large", message: "Request body too large", details: null },
  });

  for (const payload of [{}, { content: 5 }, { content: "abc", extra: 1 }, { content: "abc", source: "send" }]) {
    const response = await post(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_failed", message: "Request validation failed",
        details: { errors: [expect.objectContaining({ path: expect.any(String), message: expect.any(String) })] },
      },
    });
  }

  const contentError = {
    error: {
      code: "validation_failed", message: "Request validation failed",
      details: { errors: [{
        path: "/content",
        message: "must be at most 1000000 characters and must not contain NUL or unpaired surrogates",
      }] },
    },
  };
  for (const content of ["A\u0000B", "\ud800", "a".repeat(1000001), "😀".repeat(1000001)]) {
    const response = await post({ content });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(contentError);
  }
  const unknownInvalidContent = await post({ content: "\ud800" }, "bk_000000000000");
  expect(unknownInvalidContent.statusCode).toBe(404);
  expect(unknownInvalidContent.json().error.message).toBe("Book not found");

  expect(await corpusCounts(pool)).toEqual({ ledger: 5, chapters: 5, versions: 5, active: 0 });
  expect(await ledgerRows()).toEqual(before);
});
