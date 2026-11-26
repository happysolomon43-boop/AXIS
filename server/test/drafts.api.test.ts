import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { createChapterWithFirstVersion, type ChapterCreated, type VersionWritten } from "../src/corpus/repo.js";
import type { DraftDetail, DraftInput } from "../src/drafts/repository.js";
import { makePool, resetDb } from "./helpers.js";
import { intakeCounts, seedSeries } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice", "content-type": "application/json" };
const bob = { ...alice, "x-axis-user": "usr_bob" };
const initial = "# Title\n\nOne";
const edited = "# Title\n\nOne!";
let app: FastifyInstance;
let chapter: ChapterCreated["chapter"];
let version: ChapterCreated["version"];

beforeEach(async () => {
  await resetDb(pool);
  const { bookId, seriesId } = await seedSeries(pool, "usr_alice");
  await seedSeries(pool, "usr_bob");
  ({ chapter, version } = await createChapterWithFirstVersion(
    pool, "usr_alice", { id: bookId, series_id: seriesId }, initial, "draft_edit",
  ));
  app = buildApp({ pool });
});

afterEach(() => app.close());
afterAll(() => pool.end());

function put(
  input: object | string,
  { id = chapter.id, headers = alice as Record<string, string> } = {},
) {
  return app.inject({ method: "PUT", url: `/chapters/${id}/draft`, headers, payload: input });
}

function get(id = chapter.id, headers: Record<string, string> = alice) {
  return app.inject({ method: "GET", url: `/chapters/${id}/draft`, headers });
}

function body(content = edited, base_revision = 0, base_version = version.id): DraftInput {
  return { content, base_version, base_revision };
}

function conflict(reason: "version" | "revision", current_version: string, current_revision: number) {
  return { error: {
    code: "conflict", message: "Draft is out of date", details: { reason, current_version, current_revision },
  } };
}

async function write(action: "versions" | "send", parent_version: string) {
  const reply = await app.inject({
    method: "POST", url: `/chapters/${chapter.id}/${action}`, headers: alice,
    payload: { content: edited, parent_version },
  });
  expect(reply.statusCode, reply.body).toBe(201);
  return reply.json<VersionWritten>().version.id;
}

test("AC1 creates and updates the head without recording any version or input", async () => {
  const before = await intakeCounts(pool);
  const first = await put(body());
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json()).toEqual({ chapter: { ...chapter, order_key: "0000001000" }, base_version: version.id, revision: 1, sync: { state: "draft_only", same: false } });
  expect((await pool.query("SELECT * FROM chapter_drafts")).rows).toEqual([
    { chapter_id: chapter.id, base_version: version.id, content: edited, revision: 1 },
  ]);

  const second = await put(body("", 1));
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json()).toEqual({ chapter, base_version: version.id, revision: 2, sync: { state: "draft_only", same: false } });
  expect((await pool.query("SELECT content FROM chapter_drafts")).rows).toEqual([{ content: "" }]);

  const limit = await put(body("😀".repeat(1000000), 2));
  expect(limit.statusCode, limit.body).toBe(200);
  expect(limit.json()).toEqual({ chapter, base_version: version.id, revision: 3, sync: { state: "draft_only", same: false } });
  expect((await pool.query("SELECT char_length(content) AS count FROM chapter_drafts")).rows).toEqual([{ count: 1000000 }]);
  expect(await intakeCounts(pool)).toEqual(before);
});

test("AC2 authenticates, validates and checks ownership in order and writes nothing on failure", async () => {
  const invalidBody = { ...body(), extra: true };
  const auth = await put(invalidBody, { headers: { "content-type": "application/json" } });
  expect(auth.statusCode).toBe(401);
  expect(auth.json().error.code).toBe("auth_required");

  for (const input of [
    invalidBody, { ...body(), base_revision: -1 }, { ...body(), base_revision: "0" },
    { ...body(), base_revision: 0.5 }, { ...body(), base_revision: 2147483648 },
    { ...body(), base_version: "" }, { ...body(), base_version: "v".repeat(65) },
    { ...body(), content: 4 }, { content: edited, base_version: version.id },
  ]) {
    const invalid = await put(input, { headers: bob });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json().error.code).toBe("validation_failed");
  }
  for (const content of ["x".repeat(1000001), "a\u0000b", "\ud800"]) {
    const invalid = await put(body(content));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: {
      code: "validation_failed", message: "Request validation failed", details: { errors: [{
        path: "/content", message: "must be at most 1000000 characters and must not contain NUL or unpaired surrogates",
      }] },
    } });
  }

  for (const options of [
    { headers: bob }, { id: "ch_000000000000" }, { id: "c".repeat(65) },
    { id: "c".repeat(100) }, { id: "c%00" },
  ]) {
    const hidden = await put(body("\u0000"), options);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error).toEqual({ code: "not_found", message: "Chapter not found", details: null });
  }
  const outsideRoute = await put(body(), { id: "c".repeat(101) });
  expect(outsideRoute.statusCode).toBe(404);
  expect(outsideRoute.json().error.message).toBe("Route not found");

  const wrongMedia = await put("text", { headers: { ...alice, "content-type": "text/plain" } });
  expect(wrongMedia.statusCode).toBe(415);
  expect(wrongMedia.json().error.code).toBe("unsupported_media_type");
  const tooLarge = await put(body("\u0001".repeat(1400000)));
  expect(tooLarge.statusCode).toBe(413);
  expect(tooLarge.json().error.code).toBe("payload_too_large");
  expect((await pool.query("SELECT * FROM chapter_drafts")).rows).toEqual([]);
});

test("AC3 checks version before revision and serializes two concurrent PUTs", async () => {
  expect((await put(body())).statusCode).toBe(200);
  const wrongRevision = await put(body());
  expect(wrongRevision.statusCode).toBe(409);
  expect(wrongRevision.json()).toEqual(conflict("revision", version.id, 1));

  for (const revision of [1, 0]) {
    const wrongVersion = await put(body(edited, revision, "ver_000000000000"));
    expect(wrongVersion.statusCode).toBe(409);
    expect(wrongVersion.json()).toEqual(conflict("version", version.id, 1));
  }

  const nextVersion = await write("versions", version.id);
  const stale = await put(body());
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toEqual(conflict("version", nextVersion, 0));

  const contents = ["first competing draft", "second competing draft"];
  const replies = await Promise.all(contents.map((content) => put(body(content, 0, nextVersion))));
  expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
  const winner = replies.findIndex((reply) => reply.statusCode === 200);
  expect(replies[winner]!.json()).toEqual({ chapter, base_version: nextVersion, revision: 1, sync: { state: "draft_only", same: false } });
  expect(replies[1 - winner]!.json()).toEqual(conflict("revision", nextVersion, 1));
  expect((await pool.query("SELECT content FROM chapter_drafts")).rows).toEqual([{ content: contents[winner] }]);

  await pool.query("UPDATE chapter_drafts SET revision = 2147483647 WHERE chapter_id = $1", [chapter.id]);
  const overflow = await put(body("unwritten", 2147483647, nextVersion));
  expect(overflow.statusCode).toBe(500);
  expect(overflow.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
  expect((await pool.query("SELECT content, revision FROM chapter_drafts")).rows)
    .toEqual([{ content: contents[winner], revision: 2147483647 }]);
});

test("AC4 reads head content and segmented blocks, then returns null after Save or Send", async () => {
  const none = { chapter, draft: null, sync: { state: "draft_only", same: false } };
  const empty = await get();
  expect(empty.statusCode).toBe(200);
  expect(empty.json()).toEqual(none);
  const samples = [
    { content: edited, blocks: [
      { ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "One!" },
    ] },
    { content: "", blocks: [] },
    { content: "a\n\n***\n\nb", blocks: [
      { ordinal: 1, kind: "paragraph", text: "a" }, { ordinal: 2, kind: "scene_break", text: "***" },
      { ordinal: 3, kind: "paragraph", text: "b" },
    ] },
  ];
  for (const [revision, { content, blocks }] of samples.entries()) {
    expect((await put(body(content, revision))).statusCode).toBe(200);
    const before = await intakeCounts(pool);
    const read = await get();
    expect(read.statusCode).toBe(200);
    expect(read.json<DraftDetail>()).toEqual({
      chapter, draft: { base_version: version.id, revision: revision + 1, content, blocks },
      sync: none.sync,
    });
    expect(await intakeCounts(pool)).toEqual(before);
    expect((await pool.query("SELECT revision, content FROM chapter_drafts")).rows)
      .toEqual([{ revision: revision + 1, content }]);
  }
  const nextVersion = await write("versions", version.id);
  expect((await get()).json()).toEqual(none);
  expect((await put(body(edited, 0, nextVersion))).statusCode).toBe(200);
  await write("send", nextVersion);
  expect((await get()).json()).toEqual({ ...none, sync: { state: "in_book", same: true } });

  expect((await get(chapter.id, {})).statusCode).toBe(401);
  for (const [id, headers, message] of [
    [chapter.id, bob, "Chapter not found"], ["c".repeat(65), alice, "Chapter not found"],
    ["c%00", alice, "Chapter not found"], ["c".repeat(101), alice, "Route not found"],
  ] as const) {
    const hidden = await get(id, headers);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.message).toBe(message);
  }
});
