import type { Pool } from "pg";

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
