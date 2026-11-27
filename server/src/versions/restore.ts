import type { Pool } from "pg";
import type { ChapterRef, ChapterRow, SceneRow, VersionRow } from "../corpus/repo.js";
import { insertCheckpointLabel } from "../named-cuts/checkpoint-label.js";

export type RestoreWritten = {
  chapter: ChapterRow;
  version: VersionRow;
  active_version_id: string | null;
  checkpoint_version_id: string | null;
};

type StoredText = { id: string; content: string };
type SceneHints = Pick<SceneRow, "ordinal" | "pov_hint" | "location_hint" | "time_hint" | "time_mode">;
type StoredVersion = Omit<VersionRow, "l_seq"> & { l_seq: string };

const commitVersion = "SELECT commit_inputs($1, 'corpus', $2, $3, $4::jsonb)";

export async function restoreVersion(
  pool: Pool, actorId: string, chapter: ChapterRef, versionId: string,
): Promise<RestoreWritten | null> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const { rows: [source] } = await client.query<StoredText>(
      "SELECT id, content FROM chapter_versions WHERE id = $1 AND chapter_id = $2",
      [versionId, chapter.id],
    );
    if (!source) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows: [newest] } = await client.query<StoredText>(
      "SELECT id, content FROM chapter_versions WHERE chapter_id = $1 ORDER BY version_no DESC LIMIT 1",
      [chapter.id],
    );
    if (!newest) throw new Error("Restore source has no newest version");
    const { rows: [head] } = await client.query<{ content: string }>(
      "SELECT content FROM chapter_drafts WHERE chapter_id = $1",
      [chapter.id],
    );
    const { rows: scenes } = await client.query<SceneHints>(
      `SELECT ordinal, pov_hint, location_hint, time_hint, time_mode
       FROM scenes WHERE version_id = $1 ORDER BY ordinal`,
      [source.id],
    );
    const hints = scenes.map(({ pov_hint: pov, location_hint: location, time_hint: time, time_mode }) =>
      pov === null && location === null && time === null && time_mode === "linear"
        ? null
        : { pov, location, time, time_mode },
    );

    let checkpointVersionId: string | null = null;
    if (head !== undefined && head.content !== newest.content) {
      const { rows: [commit] } = await client.query<{ commit_inputs: { ids: string[] } }>(
        commitVersion, [chapter.series_id, actorId, "chapter.checkpoint", JSON.stringify([{
          kind: "chapter_version", chapter_id: chapter.id, content: head.content, source: "checkpoint",
        }])],
      );
      const id = commit?.commit_inputs.ids[0];
      if (!id) throw new Error("Restore rows are missing");
      await insertCheckpointLabel(client, chapter, id, "restore");
      checkpointVersionId = id;
    }
    await client.query(commitVersion, [chapter.series_id, actorId, "chapter.restore", JSON.stringify([{
      kind: "chapter_version", chapter_id: chapter.id, content: source.content, source: "restore",
      ...(hints.some((hint) => hint !== null) ? { hints } : {}),
    }])]);

    const { rows: [version] } = await client.query<StoredVersion>(
      `SELECT id, chapter_id, version_no, source, text_hash, hints_hash, parent_version, l_seq
       FROM chapter_versions WHERE chapter_id = $1 ORDER BY version_no DESC LIMIT 1`,
      [chapter.id],
    );
    const { rows: [current] } = await client.query<ChapterRow & { active_version_id: string | null }>(
      `SELECT c.id, c.book_id, c.order_key,
              (SELECT a.version_id FROM chapter_active AS a WHERE a.chapter_id = c.id
               ORDER BY a.since_l DESC LIMIT 1) AS active_version_id
       FROM chapters AS c WHERE c.id = $1`,
      [chapter.id],
    );
    if (!current || !version) throw new Error("Restore rows are missing");

    const { active_version_id, ...chapterRow } = current;
    await client.query("COMMIT");
    return {
      chapter: chapterRow,
      version: { ...version, version_no: Number(version.version_no), l_seq: Number(version.l_seq) },
      active_version_id,
      checkpoint_version_id: checkpointVersionId,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
