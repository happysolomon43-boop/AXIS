import type { Pool, PoolClient } from "pg";

export type ChapterRow = {
  id: string;
  book_id: string;
  order_key: string;
};

export type VersionRow = {
  id: string;
  chapter_id: string;
  version_no: number;
  source: "draft_edit" | "send" | "reupload" | "restore" | "import" | "bulk_replace" | "checkpoint";
  text_hash: string;
  hints_hash: string;
  parent_version: string | null;
  l_seq: number;
};

export type ChapterCreated = { chapter: ChapterRow; version: VersionRow };

export type BlockRow = {
  block_uid: string;
  ordinal: number;
  kind: "paragraph" | "heading" | "scene_break";
  text: string;
  hash: string;
};

export type SceneRow = {
  ordinal: number;
  fingerprint: string;
  first_block: number;
  last_block: number;
  pov_hint: string | null;
  location_hint: string | null;
  time_hint: string | null;
  time_mode: "linear" | "flashback" | "skip" | "loop";
};

export type VersionDetail = VersionRow & { content: string };

export type ChapterDetail = {
  chapter: ChapterRow;
  version: VersionDetail | null;
  active_version_id: string | null;
  blocks: BlockRow[];
  scenes: SceneRow[];
};

type OwnedBook = { id: string; series_id: string };

export async function findOwnedBook(
  pool: Pool,
  ownerId: string,
  bookId: string,
): Promise<OwnedBook | null> {
  const { rows: [book] } = await pool.query<OwnedBook>(
    `SELECT b.id, b.series_id FROM books AS b
     JOIN series AS s ON s.id = b.series_id
     WHERE b.id = $1 AND s.owner_id = $2`,
    [bookId, ownerId],
  );
  return book ?? null;
}

export async function createChapterWithFirstVersion(
  pool: Pool,
  actorId: string,
  book: OwnedBook,
  content: string,
  source: VersionRow["source"],
): Promise<ChapterCreated> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN");
    const input = [
      { kind: "chapter", book_id: book.id },
      { kind: "chapter_version", chapter_ref: 0, content, source },
    ];
    const { rows: [committed] } = await client.query<{ result: { l_seq: number; ids: string[] } }>(
      "SELECT commit_inputs($1, 'corpus', $2, 'chapter.create', $3::jsonb) AS result",
      [book.series_id, actorId, JSON.stringify(input)],
    );
    const [chapterId, versionId] = committed?.result.ids ?? [];
    if (!chapterId || !versionId) throw new Error("Chapter commit returned no IDs");

    const { rows: [chapter] } = await client.query<ChapterRow>(
      "SELECT id, book_id, order_key FROM chapters WHERE id = $1",
      [chapterId],
    );
    const { rows: [version] } = await client.query<Omit<VersionRow, "l_seq"> & { l_seq: string }>(
      `SELECT id, chapter_id, version_no, source, text_hash, hints_hash, parent_version, l_seq
       FROM chapter_versions WHERE id = $1`,
      [versionId],
    );
    if (!chapter || !version) throw new Error("Chapter commit returned missing rows");

    await client.query("COMMIT");
    return { chapter, version: { ...version, l_seq: Number(version.l_seq) } };
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

type OwnedChapter = { id: string; book_id: string; series_id: string };

export async function findOwnedChapter(
  db: Pick<Pool, "query">,
  ownerId: string,
  chapterId: string,
): Promise<OwnedChapter | null> {
  const { rows: [chapter] } = await db.query<OwnedChapter>(
    `SELECT c.id, c.book_id, b.series_id
     FROM chapters AS c JOIN books AS b ON b.id = c.book_id
     JOIN series AS s ON s.id = b.series_id
     WHERE c.id = $1 AND s.owner_id = $2`,
    [chapterId, ownerId],
  );
  return chapter ?? null;
}

async function readChapterDetail(client: PoolClient, chapterId: string): Promise<ChapterDetail> {
  const { rows: [chapter] } = await client.query<ChapterRow>(
    "SELECT id, book_id, order_key FROM chapters WHERE id = $1",
    [chapterId],
  );
  if (!chapter) throw new Error("Chapter is missing from the read snapshot");

  const { rows: [latest] } = await client.query<Omit<VersionDetail, "l_seq"> & { l_seq: string }>(
    `SELECT id, chapter_id, version_no, source, text_hash, hints_hash, parent_version, l_seq, content
     FROM chapter_versions WHERE chapter_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [chapterId],
  );
  const { rows: [active] } = await client.query<{ version_id: string | null }>(
    "SELECT version_id FROM chapter_active WHERE chapter_id = $1 ORDER BY since_l DESC LIMIT 1",
    [chapterId],
  );

  const activeVersionId = active?.version_id ?? null;
  if (!latest) {
    return { chapter, version: null, active_version_id: activeVersionId, blocks: [], scenes: [] };
  }

  const { rows: blocks } = await client.query<BlockRow>(
    "SELECT block_uid, ordinal, kind, text, hash FROM blocks WHERE version_id = $1 ORDER BY ordinal",
    [latest.id],
  );
  const { rows: scenes } = await client.query<SceneRow>(
    `SELECT ordinal, fingerprint, first_block, last_block, pov_hint, location_hint, time_hint, time_mode
     FROM scenes WHERE version_id = $1 ORDER BY ordinal`,
    [latest.id],
  );
  return {
    chapter,
    version: { ...latest, l_seq: Number(latest.l_seq) },
    active_version_id: activeVersionId,
    blocks,
    scenes,
  };
}

export function getChapterDetail(pool: Pool, chapterId: string): Promise<ChapterDetail>;
export function getChapterDetail(pool: Pool, chapterId: string, ownerId: string): Promise<ChapterDetail | null>;
export async function getChapterDetail(
  pool: Pool,
  chapterId: string,
  ownerId?: string,
): Promise<ChapterDetail | null> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Keep ownership and all response data in the same snapshot.
    const allowed = ownerId === undefined || await findOwnedChapter(client, ownerId, chapterId);
    const detail = allowed ? await readChapterDetail(client, chapterId) : null;
    await client.query("COMMIT");
    return detail;
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
