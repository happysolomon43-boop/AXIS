import { observedWriteGuard, writeGuard } from "./helpers.js";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { ActivationWritten, ChapterCreated, ChapterDetail, VersionWritten } from "../src/corpus/repo.js";
import type { SeriesTree } from "../src/series/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { emptyHash, helloHash, intakeCounts, seedSeries, story } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice", "content-type": "application/json" };
const three = "A\n\n---\n\nB\n\n---\n\nC";
const defaultHints = { pov_hint: null, location_hint: null, time_hint: null, time_mode: "linear" };
const fieldMessages = {
  "/content": "must be at most 1000000 characters and must not contain NUL or unpaired surrogates",
  "/hints": "must be null or an array with at most one element per scene; each element is null or an object with only pov, location, time and time_mode; pov, location and time are null or 1 to 200 characters; time_mode is null or one of linear, flashback, skip, loop",
  "/parent_version": "must be the id of a version of this chapter",
};
let app: FastifyInstance;
let seriesId: string;
let bookId: string;

beforeEach(async () => {
  await resetDb(pool);
  app = buildApp({ pool });
  ({ seriesId, bookId } = await seedSeries(pool));
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

function post(
  id: string,
  action: "versions" | "send" | "activate",
  payload: object | string,
  headers: Record<string, string> = alice,
) {
  return app.inject({ method: "POST", url: `/chapters/${id}/${action}`, headers, payload });
}

async function create(content: string, book = bookId) {
  const response = await app.inject({
    method: "POST", url: `/books/${book}/chapters`, headers: alice, payload: { content },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ChapterCreated>();
}

async function write(id: string, action: "versions" | "send", payload: object) {
  const response = await post(id, action, { ...await observedWriteGuard(pool, id), ...payload });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<VersionWritten>();
}

async function activate(id: string, versionId: string | null) {
  const response = await post(id, "activate", { version_id: versionId });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ActivationWritten>();
}

async function read(id: string) {
  const response = await app.inject({ method: "GET", url: `/chapters/${id}`, headers: alice });
  expect(response.statusCode).toBe(200);
  return response.json<ChapterDetail>();
}

async function chapterOnly() {
  const { rows: [row] } = await pool.query<{ result: { ids: string[] } }>(
    "SELECT commit_inputs($1, 'corpus', 'usr_alice', 'chapter.create', $2::jsonb) AS result",
    [seriesId, JSON.stringify([{ kind: "chapter", book_id: bookId }])],
  );
  return row!.result.ids[0]!;
}

async function ledgerAt(lSeq: number, series = seriesId) {
  return (await pool.query(
    "SELECT actor, door, op, target_ids FROM ledger WHERE series_id = $1 AND l_seq = $2", [series, lSeq],
  )).rows;
}

async function activations(chapterId: string) {
  return (await pool.query(
    "SELECT version_id, since_l::int FROM chapter_active WHERE chapter_id = $1 ORDER BY since_l", [chapterId],
  )).rows;
}

function expectFieldError(response: Awaited<ReturnType<typeof post>>, path: keyof typeof fieldMessages) {
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toEqual({
    error: {
      code: "validation_failed", message: "Request validation failed",
      details: { errors: [{ path, message: fieldMessages[path] }] },
    },
  });
}

async function hashCanonical(canonical: string) {
  return (await pool.query<{ hash: string }>(
    "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS hash", [canonical],
  )).rows[0]!.hash;
}

test("AC1 saves versions with correct ancestry, optional hints, and unchanged activation", async () => {
  const first = await create(story);
  const result = await write(first.chapter.id, "versions", { content: "hello" });
  expect(result).toMatchObject({
    chapter: first.chapter,
    version: {
      id: expect.stringMatching(/^ver_[0-9a-f]{12}$/), chapter_id: first.chapter.id,
      version_no: 2, source: "draft_edit", parent_version: first.version.id,
      text_hash: helloHash, hints_hash: emptyHash, l_seq: 2,
    },
    active_version_id: null,
    current: { sync: { state: "draft_only", same: false } },
  });
  expect(await read(first.chapter.id)).toMatchObject({
    version: { id: result.version.id, version_no: 2 }, blocks: [{ text: "hello" }], active_version_id: null,
  });
  expect(await ledgerAt(2)).toEqual([{
    actor: "usr_alice", door: "corpus", op: "chapter.version.append", target_ids: [result.version.id],
  }]);
  expect((await write(first.chapter.id, "versions", { content: "x", source: "import" })).version.source)
    .toBe("import");

  const ordered = await create("alpha\n\nbeta");
  const parentBlocks = (await read(ordered.chapter.id)).blocks;
  await write(ordered.chapter.id, "versions", {
    content: "beta\n\nalpha", parent_version: ordered.version.id,
  });
  const reordered = (await read(ordered.chapter.id)).blocks;
  expect(reordered.map(({ block_uid }) => block_uid)).toEqual(
    parentBlocks.map(({ block_uid }) => block_uid).reverse(),
  );

  const hinted = await write(first.chapter.id, "versions", {
    content: "a\n\n---\n\nb", hints: [{ pov: "Lyra", time_mode: "flashback" }],
  });
  expect(hinted.version.hints_hash).toBe(await hashCanonical('[1, "Lyra", null, null, "flashback"]\n'));
  expect((await read(first.chapter.id)).scenes).toMatchObject([
    { ...defaultHints, pov_hint: "Lyra", time_mode: "flashback" },
    defaultHints,
  ]);
  for (const hints of [null, []]) {
    expect((await write(first.chapter.id, "versions", { content: "abc", hints })).version.hints_hash).toBe(emptyHash);
  }
  const emptyChapter = await chapterOnly();
  const versionless = await post(emptyChapter, "versions", { content: "x", ...writeGuard(first.version.id) });
  expect(versionless.statusCode).toBe(400);
});

test("AC2 sends or reuploads according to the locked active state, including concurrent requests", async () => {
  const first = await create("abc");
  const id = first.chapter.id;
  const sent = await write(id, "send", { content: "hello" });
  expect(sent.version).toMatchObject({ version_no: 2, l_seq: 2, source: "send", parent_version: first.version.id });
  expect(sent.active_version_id).toBe(sent.version.id);
  expect(await ledgerAt(2)).toEqual([{
    actor: "usr_alice", door: "corpus", op: "chapter.send", target_ids: [sent.version.id],
  }]);
  expect(await activations(id)).toEqual([{ version_id: sent.version.id, since_l: 2 }]);

  const second = await write(id, "send", { content: "hello again" });
  expect(second.version).toMatchObject({
    version_no: 3, l_seq: 3, source: "reupload", parent_version: sent.version.id,
  });
  expect(await activate(id, null)).toMatchObject({ active_version_id: null, l_seq: 4 });
  expect((await write(id, "send", { content: "x" })).version).toMatchObject({ source: "send", l_seq: 5 });
  expect(await activate(id, first.version.id)).toMatchObject({ active_version_id: first.version.id, l_seq: 6 });
  expect((await write(id, "send", { content: "y" })).version)
    .toMatchObject({ source: "reupload", version_no: 5, l_seq: 7 });

  const before = await intakeCounts(pool);
  const wrongSource = await post(id, "send", { content: "abc", source: "send" });
  expect(wrongSource.statusCode).toBe(400);
  expect(wrongSource.json().error.code).toBe("validation_failed");
  expect(await intakeCounts(pool)).toEqual(before);

  const fresh = await app.inject({
    method: "POST", url: "/series", headers: alice, payload: { title: "Ashfall" },
  });
  expect(fresh.statusCode).toBe(201);
  const { books } = fresh.json<SeriesTree>();
  const { chapter, version } = await create("abc", books[0]!.id);
  expect(version.l_seq).toBe(1);
  const simultaneous = await Promise.all(
    Array.from({ length: 5 }, (_, i) => post(chapter.id, "send", { content: `s${i + 1}`, ...writeGuard(version.id) })),
  );
  expect(simultaneous.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
  const winner = simultaneous.find((r) => r.statusCode === 201)!.json<VersionWritten>();
  expect(winner.version).toMatchObject({ source: "send", version_no: 2, l_seq: 2 });
  expect(await activations(chapter.id)).toEqual([{ version_id: winner.version.id, since_l: 2 }]);
  expect((await read(chapter.id)).active_version_id).toBe(winner.version.id);
});

test("AC3 activates an owned version or a null marker and makes repeated activation append-only", async () => {
  const first = await create("abc");
  const id = first.chapter.id;
  const second = await write(id, "versions", { content: "hello" });
  const other = await create("abc");
  const active = await activate(id, first.version.id);
  expect(active).toEqual({ chapter: first.chapter, active_version_id: first.version.id, l_seq: 4 });
  expect(await ledgerAt(active.l_seq)).toEqual([{
    actor: "usr_alice", door: "corpus", op: "chapter.activate", target_ids: [id],
  }]);
  expect((await read(id)).active_version_id).toBe(first.version.id);

  expect((await activate(id, second.version.id)).active_version_id).toBe(second.version.id);
  const inactive = await activate(id, null);
  expect(inactive.active_version_id).toBeNull();
  expect((await read(id)).active_version_id).toBeNull();
  expect((await activations(id)).at(-1)).toEqual({ version_id: null, since_l: inactive.l_seq });

  const repeatedA = await activate(id, second.version.id);
  const repeatedB = await activate(id, second.version.id);
  expect(repeatedB.l_seq).toBe(repeatedA.l_seq + 1);
  expect((await activations(id)).slice(-2)).toEqual([
    { version_id: second.version.id, since_l: repeatedA.l_seq },
    { version_id: second.version.id, since_l: repeatedB.l_seq },
  ]);
  const noVersion = await activate(await chapterOnly(), null);
  expect(noVersion.active_version_id).toBeNull();

  const before = await intakeCounts(pool);
  for (const version_id of [other.version.id, "ver_000000000000", "a".repeat(65), "A\u0000B"]) {
    const response = await post(id, "activate", { version_id });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "not_found", message: "Version not found", details: null },
    });
    expect(await intakeCounts(pool)).toEqual(before);
  }
  for (const payload of [{}, { version_id: 5 }, { version_id: "x", extra: 1 }]) {
    const response = await post(id, "activate", payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_failed");
    expect(await intakeCounts(pool)).toEqual(before);
  }
  expect((await activate(id, null)).l_seq).toBe(noVersion.l_seq + 1);
});

test("AC4 rejects invalid requests in contract order and preserves every data table", async () => {
  const first = await create("abc");
  const other = await create("abc");
  const id = first.chapter.id;
  const before = await intakeCounts(pool);
  const unknownChapter = {
    error: { code: "not_found", message: "Chapter not found", details: null },
  };

  for (const action of ["versions", "send", "activate"] as const) {
    const payload = action === "activate" ? { version_id: null } : { content: "abc", ...writeGuard(first.version.id) };
    const anonymous = await post(id, action, "{bad", { "content-type": "application/json" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("auth_required");
    expect(await intakeCounts(pool)).toEqual(before);

    const denied = await post(id, action, payload, { ...alice, "x-axis-user": "usr_bob" });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(unknownChapter);
    expect(await intakeCounts(pool)).toEqual(before);

    for (const missing of ["ch_000000000000", "not-an-id", "%00", "a".repeat(65)]) {
      const response = await post(missing, action, payload);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual(unknownChapter);
      expect(await intakeCounts(pool)).toEqual(before);
    }
    const tooLong = await post("a".repeat(101), action, payload);
    expect(tooLong.statusCode).toBe(404);
    expect(tooLong.json()).toEqual({
      error: { code: "not_found", message: "Route not found", details: null },
    });
    expect(await intakeCounts(pool)).toEqual(before);
  }

  for (const action of ["versions", "send"] as const) {
    for (const payload of [{}, { content: 5 }, { content: "abc", extra: 1 },
      { content: "abc", parent_version: null }, ...[{}, "Lyra", 1].map((hints) => ({ content: three, hints }))]) {
      const response = await post(id, action, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("validation_failed");
      expect(await intakeCounts(pool)).toEqual(before);
    }
    for (const content of ["a".repeat(1000001), "A\u0000B", "\ud800"]) {
      expectFieldError(await post(id, action, { content, ...writeGuard(first.version.id) }), "/content");
      expect(await intakeCounts(pool)).toEqual(before);
    }
    const unsupported = await post(id, action, '{"content":"abc"}', { ...alice, "content-type": "text/plain" });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error.code).toBe("unsupported_media_type");
    expect(await intakeCounts(pool)).toEqual(before);

    for (const parent_version of [other.version.id, "ver_000000000000", "", "a".repeat(65), "A\u0000B"]) {
      expectFieldError(await post(id, action, { content: "abc", parent_version, ...writeGuard(first.version.id) }), "/parent_version");
      expect(await intakeCounts(pool)).toEqual(before);
    }
    for (const hints of [
      [null, null, null, null], ["Lyra"], [{ mood: "calm" }], [{ pov: 1 }],
      [{ pov: "a".repeat(201) }], [{ time_mode: "sideways" }], [{ pov: "A\u0000B" }],
      [{ location: "\ud800" }], [{ time: { "\u0000": "x" } }], [{ time: { deep: ["x"] } }],
    ]) {
      expectFieldError(await post(id, action, { content: three, hints, ...writeGuard(first.version.id) }), "/hints");
      expect(await intakeCounts(pool)).toEqual(before);
    }
    expectFieldError(await post(id, action, { content: "", hints: [null], ...writeGuard(first.version.id) }), "/hints");
    expect(await intakeCounts(pool)).toEqual(before);

    const oversized = await post(id, action, " ".repeat(8388609));
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe("payload_too_large");
    expect(await intakeCounts(pool)).toEqual(before);
  }
  for (const source of ["bogus", "send", "reupload", "restore", "checkpoint", "bulk_replace"]) {
    const response = await post(id, "versions", { content: "abc", source, ...writeGuard(first.version.id) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_failed");
    expect(await intakeCounts(pool)).toEqual(before);
  }
  const oversizedActivation = await post(id, "activate", " ".repeat(1048577));
  expect(oversizedActivation.statusCode).toBe(413);
  expect(await intakeCounts(pool)).toEqual(before);
  expect((await write(id, "versions", { content: "abc" })).version.l_seq).toBe(other.version.l_seq + 1);
});

test("AC5 sends complete intake, large content, version-specific hints, and explicit parents", async () => {
  const first = await create("abc");
  const id = first.chapter.id;
  const sent = await write(id, "send", { content: story });
  const detail = await read(id);
  expect(detail.blocks).toHaveLength(6);
  expect(detail.scenes).toHaveLength(3);
  expect(detail.active_version_id).toBe(sent.version.id);

  await write(id, "send", { content: "a".repeat(1000000) });
  expect((await read(id)).blocks).toHaveLength(1);
  const before = await intakeCounts(pool);
  expectFieldError(await post(id, "send", { content: "a".repeat(1000001), ...writeGuard(sent.version.id) }), "/content");
  expect(await intakeCounts(pool)).toEqual(before);

  const canon = [{ pov: "Lyra", time_mode: "flashback" }, null, { location: "Harbor City", time: "March 2018" }];
  const canonical = '[1, "Lyra", null, null, "flashback"]\n[3, null, "Harbor City", "March 2018", "linear"]\n';
  const hinted = await write(id, "send", { content: three, hints: canon });
  expect(hinted.version.hints_hash).toBe(await hashCanonical(canonical));
  expect((await read(id)).scenes).toMatchObject([
    { ...defaultHints, pov_hint: "Lyra", time_mode: "flashback" },
    defaultHints,
    { ...defaultHints, location_hint: "Harbor City", time_hint: "March 2018" },
  ]);

  const resent = await write(id, "send", { content: three });
  expect(resent.version.hints_hash).toBe(emptyHash);
  expect(resent.version.id).not.toBe(hinted.version.id);
  expect((await read(id)).scenes).toMatchObject([defaultHints, defaultHints, defaultHints]);

  const branched = await create("abc");
  await write(branched.chapter.id, "versions", { content: "x" });
  const latest = await write(branched.chapter.id, "versions", { content: "hello" });
  expect(latest.version.version_no).toBe(3);
  const withOldParent = await post(branched.chapter.id, "send", {
    content: "y", parent_version: branched.version.id, ...writeGuard(latest.version.id),
  });
  expect(withOldParent.statusCode).toBe(409);
  const withParent = await write(branched.chapter.id, "send", {
    content: "y", parent_version: latest.version.id,
  });
  expect(withParent.version).toMatchObject({ version_no: 4, parent_version: latest.version.id });

  const emptyChapter = await chapterOnly();
  const versionless = await post(emptyChapter, "send", { content: "x", ...writeGuard(sent.version.id) });
  expect(versionless.statusCode).toBe(400);
});
