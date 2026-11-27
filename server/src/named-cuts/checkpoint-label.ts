import type { PoolClient } from "pg";
import { checkpointLabelFor, type CheckpointOperation } from "./checkpoint-operations.js";

export async function insertCheckpointLabel(
  client: PoolClient,
  chapter: { id: string; series_id: string },
  versionId: string,
  op: CheckpointOperation,
): Promise<void> {
  const label = checkpointLabelFor(op);
  const { rowCount } = await client.query(
    `INSERT INTO named_cuts (chapter_id, version_id, series_id, l_seq, label)
     SELECT cv.chapter_id, cv.id, cv.series_id, cv.l_seq, $3 FROM chapter_versions cv
     WHERE cv.chapter_id = $1 AND cv.id = $2 AND cv.series_id = $4 AND cv.source = 'checkpoint'`,
    [chapter.id, versionId, label, chapter.series_id],
  );
  if (rowCount !== 1) throw new Error("checkpoint label not written");
}
