import type { Pool, PoolClient } from "pg";
import { computeSync, type ChapterSync } from "./state.js";

export async function readChapterSync(db: Pool | PoolClient, chapterId: string): Promise<ChapterSync> {
  const { rows: [row] } = await db.query<{
    latest_text_hash: string | null;
    head_text_hash: string | null;
    active_version_id: string | null;
    active_text_hash: string | null;
    pulled_from: string | null;
  }>(
    `SELECT
       (SELECT v.text_hash FROM chapter_versions v WHERE v.chapter_id = c.id
        ORDER BY v.version_no DESC LIMIT 1) AS latest_text_hash,
       (SELECT encode(sha256(convert_to(axis_fold(d.content), 'UTF8')), 'hex')
        FROM chapter_drafts d WHERE d.chapter_id = c.id) AS head_text_hash,
       a.version_id AS active_version_id,
       av.text_hash AS active_text_hash,
       (SELECT p.book_version FROM chapter_pullbacks p WHERE p.chapter_id = c.id) AS pulled_from
     FROM chapters c
     LEFT JOIN LATERAL (
       SELECT ca.version_id FROM chapter_active ca WHERE ca.chapter_id = c.id
       ORDER BY ca.since_l DESC LIMIT 1
     ) a ON true
     LEFT JOIN chapter_versions av ON av.id = a.version_id
     WHERE c.id = $1`,
    [chapterId],
  );
  if (!row) throw new Error("Chapter not found");
  return computeSync({
    activeVersionId: row.active_version_id,
    activeTextHash: row.active_text_hash,
    draftTextHash: row.head_text_hash ?? row.latest_text_hash,
    pulledFrom: row.pulled_from,
  });
}
