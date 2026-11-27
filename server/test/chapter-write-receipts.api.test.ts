import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrate.js";
import type { WorkingState } from "../src/drafts/repository.js";
import type { WriteResult } from "../src/writes/receipts.js";
import { alice, bob, fixture, labels, state } from "./namedCutsFixtures.js";
import { makePool, resetDb, writeGuard } from "./helpers.js";

const pool = makePool();
let f: Awaited<ReturnType<typeof fixture>>;
let chapter: string;
let base: string;
let path: string;

beforeEach(async () => {
  await resetDb(pool);
  f = await fixture(pool);
  const first = await f.create("River.");
  chapter = first.chapter.id;
  base = first.version.id;
  path = "/chapters/" + chapter;
});
afterEach(() => f.app.close());
afterAll(() => pool.end());

const put = (content: string, version = base, revision = 0, app = f.app) => app.inject({
  method: "PUT", url: path + "/draft", headers: alice, payload: { content, base_version: version, base_revision: revision },
});
const post = (action: string, payload: object, app = f.app) =>
  app.inject({ method: "POST", url: path + "/" + action, headers: alice, payload });
const read = (suffix: string, headers = alice, app = f.app) => app.inject({ method: "GET", url: path + suffix, headers });
const receipt = (requestId: string) => read("/write-receipts/" + requestId);
const rows = (table: string) => pool.query("SELECT * FROM " + table + " ORDER BY 1, 2").then(result => result.rows);

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// This pauses a real PostgreSQL connection after a specific statement. The other
// app still obtains its own connection from the same independent pool.
function pausedApp(match: (sql: string) => boolean) {
  const reached = barrier();
  const resume = barrier();
  const connection = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        release: client.release.bind(client),
        async query(sql: string, args?: unknown[]) {
          const result = await client.query(sql, args);
          if (match(sql)) {
            reached.resolve();
            await resume.promise;
          }
          return result;
        },
      } as PoolClient;
    },
  } as Pool;
  return { app: buildApp({ pool: connection }), reached: reached.promise, resume: resume.resolve };
}

test.each(["versions", "send"])("%s and autosave honor both Series lock orderings", async (action) => {
  const before = await state(pool);
  const body = { ...writeGuard(base), parent_version: base, content: "My manuscript." };
  const first = pausedApp(sql => sql.startsWith("INSERT INTO chapter_drafts"));
  try {
    const autosave = put("Competing manuscript.", base, 0, first.app);
    await first.reached;
    const stale = post(action, body);
    first.resume();
    expect((await autosave).statusCode).toBe(200);
    const refused = await stale;
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toEqual({ reason: "revision", current_version: base, current_revision: 1 });
    expect(await state(pool)).toEqual({ ...before, heads: [{
      chapter_id: chapter, base_version: base, revision: 1, content: "Competing manuscript.",
    }] });
    expect((await receipt(body.request_id)).json()).toEqual({ receipt: null });
  } finally {
    first.resume();
    await first.app.close();
  }
  const second = pausedApp(sql => sql.startsWith("INSERT INTO chapter_write_receipts"));
  try {
    const write = post(action, { ...body, base_revision: 1 }, second.app);
    await second.reached;
    const autosave = put("Another manuscript.", base, 1);
    second.resume();
    const written = (await write).json<WriteResult>();
    const stale = await autosave;
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toEqual({ reason: "version", current_version: written.version.id, current_revision: 0 });
    expect(written.version.l_seq).toBe(2);
    const after = await state(pool);
    expect(after.heads).toEqual([]);
    expect(after.ledger).toHaveLength(2);
    expect(after.active).toHaveLength(action === "send" ? 1 : 0);
  } finally {
    second.resume();
    await second.app.close();
  }
});

test("replays one operation by UUID, with its historical activation and separately projected current state", async () => {
  const body = { ...writeGuard(base), content: "Same manuscript.", hints: [{ location: "Gate", pov: "Mara" }] };
  const copies = await Promise.all([post("send", body), post("send", body)]);
  expect(copies.map(r => r.statusCode).sort()).toEqual([200, 201]);
  const original = copies[0]!.json<WriteResult>();
  expect(copies[1]!.json()).toEqual(original);
  expect(original.active_version_id).toBe(original.version.id);
  const separatelySent = await post("send", { ...body, ...writeGuard(original.version.id) });
  expect(separatelySent.statusCode).toBe(201);
  const advanced = separatelySent.json<WriteResult>();
  expect(advanced.version.id).not.toBe(original.version.id);
  const checked = await receipt(body.request_id);
  expect(checked.headers["cache-control"]).toBe("no-store");
  const expected = { ...original, current: advanced.current };
  expect(checked.json()).toEqual({ receipt: expected });
  const replay = await post("send", { ...body, hints: [{ pov: "Mara", location: "Gate" }] });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(expected);
  const before = await state(pool);
  for (const rejected of [await post("versions", body), await post("send", { ...body, content: "Same  manuscript." }),
    await post("restore", { version_id: base, request_id: body.request_id })]) {
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.details).toEqual({ reason: "request_mismatch" });
  }
  expect((await read("/write-receipts/" + body.request_id, bob)).statusCode).toBe(404);
  expect((await read("/write-receipts/not-a-uuid")).statusCode).toBe(400);
  expect((await receipt(randomUUID())).json()).toEqual({ receipt: null });
  expect(await state(pool)).toEqual(before);
  expect(await rows("chapter_write_receipts")).toHaveLength(2);
});

test("refuses unsafe Keep mine and retains the historical parent after an explicit safe choice", async () => {
  const other = await f.write(chapter, "Other version.", "send");
  const local = { ...writeGuard(other.version.id), parent_version: base, content: "My manuscript." };
  expect((await put("Other working text.", other.version.id)).statusCode).toBe(200);
  const before = await state(pool);
  const missing = await post("versions", { content: local.content, parent_version: base });
  expect(missing.statusCode).toBe(400);
  expect((await post("send", { ...local, base_revision: "1" })).statusCode).toBe(400);
  expect((await post("versions", { ...local, base_version: base, base_revision: 1 })).json().error.details.reason).toBe("version");
  expect((await post("keep-mine", local)).json().error.details.reason).toBe("revision");
  const refused = await post("keep-mine", { ...local, base_revision: 1 });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.details).toEqual({ reason: "draft_preserved" });
  expect(await state(pool)).toEqual(before);

  expect((await put("Other version.", other.version.id, 1)).statusCode).toBe(200);
  expect((await post("keep-mine", { ...local, base_revision: 1 })).json().error.details.reason).toBe("revision");
  const safe = await post("keep-mine", { ...local, base_revision: 2 });
  expect(safe.statusCode).toBe(201);
  expect(safe.json()).toMatchObject({
    operation: "keep_mine", version: { parent_version: base, l_seq: 3 },
    active_version_id: other.version.id, checkpoint_version_id: null,
  });
  expect(await rows("chapter_active")).toEqual(before.active);
});

test("Restore receipts bind exact source and checkpoint identity, even for the same folded text", async () => {
  const first = await f.write(chapter, "River.");
  const secondResponse = await post("versions", { ...writeGuard(first.version.id), content: " River.\n", hints: [{ pov: "Mara" }] });
  const second = secondResponse.json<WriteResult>();
  expect(second.version.text_hash).toBe(first.version.text_hash);
  expect(second.version.hints_hash).not.toBe(first.version.hints_hash);
  expect((await put("Keep exact head.", second.version.id)).statusCode).toBe(200);
  const a = { version_id: first.version.id, request_id: randomUUID() };
  const b = { version_id: second.version.id, request_id: randomUUID() };
  const firstRestore = pausedApp(sql => sql.startsWith("INSERT INTO chapter_write_receipts"));
  let results: WriteResult[];
  try {
    const first = post("restore", a, firstRestore.app);
    await firstRestore.reached;
    const other = post("restore", b);
    firstRestore.resume();
    results = (await Promise.all([first, other])).map(asyncResponse => {
      expect(asyncResponse.statusCode).toBe(201);
      return asyncResponse.json<WriteResult>();
    });
  } finally {
    firstRestore.resume();
    await firstRestore.app.close();
  }
  const [restored, later] = results as [WriteResult, WriteResult];
  expect(restored.checkpoint_version_id).not.toBeNull();
  expect(later.checkpoint_version_id).toBeNull();
  expect(later.version.hints_hash).toBe(second.version.hints_hash);
  expect((await read("/working-state")).json<WorkingState>().version?.content).toBe(" River.\n");
  expect((await receipt(a.request_id)).json()).toEqual({ receipt: { ...restored, current: later.current } });
  expect((await receipt(b.request_id)).json()).toEqual({ receipt: later });
  expect(await labels(pool)).toMatchObject([{ version_id: restored.checkpoint_version_id, label: "Before restore" }]);
  const before = await state(pool);
  expect((await post("restore", a)).statusCode).toBe(200);
  expect(await state(pool)).toEqual(before);
});

test.each(["versions", "send", "restore"])("rolls back %s when receipt insertion fails", async (action) => {
  expect((await put("Kept manuscript.")).statusCode).toBe(200);
  const before = await state(pool);
  const blocks = await rows("blocks");
  const scenes = await rows("scenes");
  await pool.query(`
    CREATE FUNCTION refuse_write_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture refusal'; END;
    $$;
    CREATE TRIGGER refuse_write_receipt BEFORE INSERT ON chapter_write_receipts
      FOR EACH ROW EXECUTE FUNCTION refuse_write_receipt();
  `);
  try {
    const request_id = randomUUID();
    const result = await post(action, action === "restore" ? { request_id, version_id: base }
      : { ...writeGuard(base, 1), request_id, content: "My manuscript." });
    expect(result.statusCode).toBe(500);
    expect(await state(pool)).toEqual(before);
    expect(await rows("blocks")).toEqual(blocks);
    expect(await rows("scenes")).toEqual(scenes);
    expect(await labels(pool)).toEqual([]);
    expect(await rows("snapshot_label_lifecycles")).toEqual([]);
    expect((await receipt(request_id)).json()).toEqual({ receipt: null });
  } finally {
    await pool.query("DROP TRIGGER refuse_write_receipt ON chapter_write_receipts; DROP FUNCTION refuse_write_receipt()");
  }
});

test("a working-state read keeps its version and head from a single PostgreSQL snapshot", async () => {
  expect((await put("River.")).statusCode).toBe(200);
  const snapshot = pausedApp(sql => sql.includes("FROM chapter_versions WHERE chapter_id = $1 ORDER BY version_no DESC LIMIT 1"));
  try {
    const working = read("/working-state", alice, snapshot.app);
    await snapshot.reached;
    const written = await f.write(chapter, "New manuscript.");
    snapshot.resume();
    const prior = await working;
    expect(prior.statusCode).toBe(200);
    expect(prior.headers["cache-control"]).toBe("no-store");
    expect(prior.json()).toMatchObject({ version: { id: base, content: "River." },
      draft: { base_version: base, revision: 1, content: "River." } });
    expect((await read("/working-state")).json()).toMatchObject({ version: { id: written.version.id }, draft: null });
    expect((await read("/working-state", bob)).statusCode).toBe(404);
    await pool.query("INSERT INTO chapter_drafts VALUES ($1, $2, 'wrong base', 1)", [chapter, base]);
    expect((await read("/working-state")).statusCode).toBe(500);
  } finally {
    snapshot.resume();
    await snapshot.app.close();
  }
});

test("forward migration and rollback preserve existing manuscripts and refuse to drop live receipts", async () => {
  const migration = "0016_chapter_write_receipts.sql";
  const down = await readFile(new URL("../db/rollback/0016_chapter_write_receipts.down.sql", import.meta.url), "utf8");
  const dir = new URL("../db/migrations/", import.meta.url).pathname;
  const before = await state(pool);
  await pool.query(down);
  expect(await state(pool)).toEqual(before);
  expect(await runMigrations(pool, dir)).toEqual([migration]);
  expect(await rows("chapter_write_receipts")).toEqual([]);
  const body = { ...writeGuard(base), content: "Written." };
  expect((await post("versions", body)).statusCode).toBe(201);
  const verified = (await receipt(body.request_id)).json();
  await expect(pool.query(down)).rejects.toMatchObject({ code: "AX002" });
  expect(await runMigrations(pool, dir)).toEqual([]);
  expect((await receipt(body.request_id)).json()).toEqual(verified);
});
