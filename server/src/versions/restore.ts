import type { Pool } from "pg";
import { readActiveVersionId, type ChapterRef, type SceneRow } from "../corpus/repo.js";
import { AppError } from "../errors.js";
import { commitChapterWrite, readWriteBase } from "../writes/receipts.js";
import { insertCheckpointLabel } from "../named-cuts/checkpoint-label.js";

type StoredText = { id: string; content: string };
type SceneHints = Pick<SceneRow, "ordinal" | "pov_hint" | "location_hint" | "time_hint" | "time_mode">;

const commitVersion = "SELECT commit_inputs($1, 'corpus', $2, $3, $4::jsonb)";

export function restoreVersion(pool: Pool, actorId: string, chapter: ChapterRef, versionId: string, requestId: string) {
  return commitChapterWrite(pool, actorId, chapter, "restore", requestId, { version_id: versionId }, async (client) => {
    const { rows: [source] } = await client.query<StoredText>(
      "SELECT id, content FROM chapter_versions WHERE id = $1 AND chapter_id = $2",
      [versionId, chapter.id],
    );
    if (!source) throw new AppError(404, "not_found", "Version not found");

    const newest = await readWriteBase(client, chapter.id);
    if (!newest) throw new Error("Restore source has no newest version");
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
    if (newest.head_content !== null && newest.head_content !== newest.content) {
      const { rows: [commit] } = await client.query<{ commit_inputs: { ids: string[] } }>(
        commitVersion, [chapter.series_id, actorId, "chapter.checkpoint", JSON.stringify([{
          kind: "chapter_version", chapter_id: chapter.id, content: newest.head_content, source: "checkpoint",
        }])],
      );
      const id = commit?.commit_inputs.ids[0];
      if (!id) throw new Error("Restore rows are missing");
      await insertCheckpointLabel(client, chapter, id, "restore");
      checkpointVersionId = id;
    }
    const { rows: [restored] } = await client.query<{ commit_inputs: { ids: string[] } }>(
      commitVersion, [chapter.series_id, actorId, "chapter.restore", JSON.stringify([{
        kind: "chapter_version", chapter_id: chapter.id, content: source.content, source: "restore",
        ...(hints.some((hint) => hint !== null) ? { hints } : {}),
      }])],
    );
    const restoredId = restored?.commit_inputs.ids[0];
    if (!restoredId) throw new Error("Restore rows are missing");
    return {
      version_id: restoredId,
      active_version_id: await readActiveVersionId(client, chapter.id),
      checkpoint_version_id: checkpointVersionId,
      source_version_id: source.id,
    };
  });
}
