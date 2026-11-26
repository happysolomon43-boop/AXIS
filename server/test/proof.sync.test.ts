import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import type { BookChapters, ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import type { DraftDetail, DraftWritten } from "../src/drafts/repository.js";
import { makePool, resetDb } from "./helpers.js";
import { corpusCounts, seedSeries } from "./seed.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
const revised = { state: "being_revised", same: false };

async function waitForWriters(expected: number) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
       AND wait_event_type = 'Lock' AND query = 'SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE'`,
    );
    if (rows.length === expected) return;
    await delay(10);
  }
  throw new Error("Expected " + expected + " waiting Series writers");
}

afterAll(() => pool.end());

test("AXB-0080 AC2 autosave replies reflect its place in either Series lock order", async () => {
  const app = buildApp({ pool });
  try {
    for (const putFirst of [true, false]) {
      await resetDb(pool);
      const { bookId, seriesId } = await seedSeries(pool);
      const listPath = "/books/" + bookId + "/chapters";
      const first = await app.inject({ method: "POST", url: listPath, headers: alice, payload: { content: "abc" } });
      expect(first.statusCode).toBe(201);
      const { chapter, version } = first.json<ChapterCreated>();
      const path = "/chapters/" + chapter.id;
      const sent = await app.inject({
        method: "POST", url: path + "/send", headers: alice,
        payload: { content: "abc", parent_version: version.id },
      });
      expect(sent.statusCode).toBe(201);
      const active = sent.json<VersionWritten>().version.id;
      const before = await corpusCounts(pool);
      const put = async () => app.inject({
        method: "PUT", url: path + "/draft", headers: alice,
        payload: { content: "abd", base_version: active, base_revision: 0 },
      });
      const pullBack = async () => app.inject({ method: "POST", url: path + "/pull-back", headers: alice });

      const holder = await pool.connect();
      const pending: ReturnType<typeof put>[] = [];
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [seriesId]);
        pending.push(putFirst ? put() : pullBack());
        await waitForWriters(1);
        pending.push(putFirst ? pullBack() : put());
        await waitForWriters(2);
      } finally {
        try {
          await holder.query("ROLLBACK");
        } finally {
          holder.release();
          await Promise.allSettled(pending);
        }
      }

      const [one, two] = await Promise.all(pending);
      const autosave = putFirst ? one! : two!;
      const pull = putFirst ? two! : one!;
      expect(autosave.statusCode, autosave.body).toBe(200);
      expect(pull.statusCode, pull.body).toBe(200);
      expect(autosave.json<DraftWritten>().sync).toEqual(putFirst ? { state: "edited", same: false } : revised);
      expect(pull.json().active_version_id).toBe(active);
      const draft = await app.inject({ method: "GET", url: path + "/draft", headers: alice });
      const list = await app.inject({ method: "GET", url: listPath, headers: alice });
      expect(draft.statusCode).toBe(200);
      expect(list.statusCode).toBe(200);
      expect(draft.json<DraftDetail>().sync).toEqual(revised);
      expect(list.json<BookChapters>().chapters[0]?.sync).toEqual(revised);
      expect(await corpusCounts(pool)).toEqual(before);
      expect((await pool.query("SELECT chapter_id, base_version, content, revision FROM chapter_drafts")).rows)
        .toEqual([{ chapter_id: chapter.id, base_version: active, content: "abd", revision: 1 }]);
      expect((await pool.query("SELECT chapter_id, book_version FROM chapter_pullbacks")).rows)
        .toEqual([{ chapter_id: chapter.id, book_version: active }]);

      const activity = await pool.query(
        `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
         AND pid <> pg_backend_pid() AND (xact_start IS NOT NULL OR wait_event_type = 'Lock')`,
      );
      expect(activity.rows).toEqual([]);
    }
  } finally {
    await app.close();
    await resetDb(pool);
  }
}, 12000);
