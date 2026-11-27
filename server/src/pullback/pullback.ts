import type { Pool } from "pg";
import { readActiveVersionId, readChapterRow, type ChapterRef, type ChapterRow, type SceneRow } from "../corpus/repo.js";
import { AppError } from "../errors.js";

export type PullBackWritten = { chapter: ChapterRow; active_version_id: string };
type Reason = "released_book" | "active_changed" | "base_choice_required";
function refuse(reason: Reason): never {
  throw new AppError(409, "pull_back_conflict", "Pull back requires a different action", { reason });
}
type SceneHints = Pick<SceneRow, "pov_hint" | "location_hint" | "time_hint" | "time_mode">;

export async function pullBackChapter(pool: Pool, chapter: ChapterRef, actorId: string, expectedActiveVersionId?: string): Promise<PullBackWritten | null> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const { rows: [owned] } = await client.query<{status: string}>(
      "SELECT b.status FROM books b JOIN chapters c ON c.book_id = b.id JOIN series s ON s.id = b.series_id WHERE c.id = $1 AND b.id = $2 AND s.id = $3 AND s.owner_id = $4 FOR SHARE OF b",
      [chapter.id, chapter.book_id, chapter.series_id, actorId],
    );
    if (!owned) { await client.query("ROLLBACK"); return null; }
    if (owned.status === "released") refuse("released_book");
    const activeVersionId = await readActiveVersionId(client, chapter.id);
    if (activeVersionId === null) throw new AppError(409, "not_in_book", "Chapter has no Book version");
    if (expectedActiveVersionId !== undefined && expectedActiveVersionId !== activeVersionId) refuse("active_changed");
    const { rows: [mark] } = await client.query<{book_version: string}>(
      "SELECT book_version FROM chapter_pullbacks WHERE chapter_id = $1", [chapter.id],
    );
    if (mark?.book_version !== activeVersionId) {
      const { rows: [state] } = await client.query<{latest_id: string; working: string; equal: boolean; hints_equal: boolean}>(
        "SELECT v.id AS latest_id, COALESCE(d.content, v.content) AS working, convert_to(COALESCE(d.content, v.content), 'UTF8') = convert_to(a.content, 'UTF8') AS equal, v.hints_hash = a.hints_hash AS hints_equal FROM chapter_versions v JOIN chapter_versions a ON a.chapter_id = v.chapter_id AND a.id = $2 LEFT JOIN chapter_drafts d ON d.chapter_id = v.chapter_id WHERE v.chapter_id = $1 ORDER BY v.version_no DESC LIMIT 1",
        [chapter.id, activeVersionId],
      );
      if (!state) throw new Error("Missing revision base");
      if (!state.equal || !state.hints_equal) refuse("base_choice_required");
      const { rows: scenes } = await client.query<SceneHints>(
        "SELECT pov_hint, location_hint, time_hint, time_mode FROM scenes WHERE version_id = $1 ORDER BY ordinal", [activeVersionId],
      );
      const hints = scenes.map(({pov_hint: pov, location_hint: location, time_hint: time, time_mode}) =>
        pov === null && location === null && time === null && time_mode === "linear" ? null : {pov, location, time, time_mode});
      await client.query("SELECT commit_inputs($1, 'corpus', $2, 'chapter.pull_back', $3::jsonb)", [
        chapter.series_id, actorId, JSON.stringify([{kind: "chapter_version", chapter_id: chapter.id,
          source: "draft_edit", parent_version: state.latest_id, content: state.working, activate: false,
          ...(hints.some(hint => hint !== null) ? {hints} : {})}]),
      ]);
      await client.query(
        "INSERT INTO chapter_pullbacks (chapter_id, book_version) VALUES ($1, $2) ON CONFLICT (chapter_id) DO UPDATE SET book_version = EXCLUDED.book_version",
        [chapter.id, activeVersionId],
      );
    }
    const chapterRow = await readChapterRow(client, chapter.id);
    await client.query("COMMIT");
    return { chapter: chapterRow, active_version_id: activeVersionId };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discardClient = true; }
    throw error;
  } finally { client.release(discardClient); }
}
