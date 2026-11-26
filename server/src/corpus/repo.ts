import type { Pool, PoolClient } from "pg";
import type { NamedSnapshot } from "../named-cuts/repository.js";
import { AppError } from "../errors.js";
import { computeSync, type ChapterSync } from "../sync/state.js";
import { invalidHints, invalidParentVersion } from "./validate.js";

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
  pool: Pick<Pool, "query">,
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

export type ChapterRef = { id: string; book_id: string; series_id: string };

export type VersionWritten = {
  chapter: ChapterRow;
  version: VersionRow;
  active_version_id: string | null;
};

export type ActivationWritten = {
  chapter: ChapterRow;
  active_version_id: string | null;
  l_seq: number;
};

type ChapterVersionInput = {
  content: string;
  parent_version?: string;
  hints?: unknown[] | null;
};

export async function findOwnedChapter(
  db: Pick<Pool, "query">,
  ownerId: string,
  chapterId: string,
): Promise<ChapterRef | null> {
  const { rows: [chapter] } = await db.query<ChapterRef>(
    `SELECT c.id, c.book_id, b.series_id
     FROM chapters AS c JOIN books AS b ON b.id = c.book_id
     JOIN series AS s ON s.id = b.series_id
     WHERE c.id = $1 AND s.owner_id = $2`,
    [chapterId, ownerId],
  );
  return chapter ?? null;
}

export async function readChapterRow(client: PoolClient, chapterId: string): Promise<ChapterRow> {
  const { rows: [chapter] } = await client.query<ChapterRow>(
    "SELECT id, book_id, order_key FROM chapters WHERE id = $1",
    [chapterId],
  );
  if (!chapter) throw new Error("Chapter is missing from the transaction");
  return chapter;
}

export async function readActiveVersionId(client: PoolClient, chapterId: string): Promise<string | null> {
  const { rows: [active] } = await client.query<{ version_id: string | null }>(
    "SELECT version_id FROM chapter_active WHERE chapter_id = $1 ORDER BY since_l DESC LIMIT 1",
    [chapterId],
  );
  return active?.version_id ?? null;
}

async function readChapterDetail(client: PoolClient, chapterId: string): Promise<ChapterDetail> {
  const chapter = await readChapterRow(client, chapterId);
  const { rows: [latest] } = await client.query<Omit<VersionDetail, "l_seq"> & { l_seq: string }>(
    `SELECT id, chapter_id, version_no, source, text_hash, hints_hash, parent_version, l_seq, content
     FROM chapter_versions WHERE chapter_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [chapterId],
  );
  const activeVersionId = await readActiveVersionId(client, chapterId);
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
  return corpusTransaction(pool, readOnlyTransaction, async (client) => {
    // Keep ownership and all response data in the same snapshot.
    const allowed = ownerId === undefined || await findOwnedChapter(client, ownerId, chapterId);
    return allowed ? readChapterDetail(client, chapterId) : null;
  });
}

const readOnlyTransaction = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

async function corpusTransaction<T>(
  pool: Pool,
  begin: "BEGIN" | typeof readOnlyTransaction,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query(begin);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
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

async function chapterHasVersion(client: PoolClient, chapterId: string, versionId: string): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT id FROM chapter_versions WHERE id = $1 AND chapter_id = $2",
    [versionId, chapterId],
  );
  return rows.length > 0;
}

async function commitChapterRow(
  client: PoolClient,
  actorId: string,
  chapter: ChapterRef,
  op: "chapter.version.append" | "chapter.send" | "chapter.activate",
  row: object,
): Promise<{ l_seq: number; ids: string[] }> {
  try {
    const { rows: [committed] } = await client.query<{ result: { l_seq: number; ids: string[] } }>(
      "SELECT commit_inputs($1, 'corpus', $2, $3, $4::jsonb) AS result",
      [chapter.series_id, actorId, op, JSON.stringify([row])],
    );
    if (!committed) throw new Error("Chapter commit returned no result");
    return committed.result;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "AX002") {
      if (error.message === "invalid hints") throw invalidHints();
      if (error.message === "invalid parent version") throw invalidParentVersion();
    }
    throw error;
  }
}

function isNestedHint(hint: unknown): boolean {
  return Array.isArray(hint) || (
    hint !== null && typeof hint === "object" &&
    Object.values(hint).some((field) => field !== null && typeof field === "object")
  );
}

async function writeVersion(
  client: PoolClient,
  actorId: string,
  chapter: ChapterRef,
  input: ChapterVersionInput,
  source: "draft_edit" | "import" | "send" | "reupload",
): Promise<VersionWritten> {
  if (input.parent_version !== undefined && !await chapterHasVersion(client, chapter.id, input.parent_version)) {
    throw invalidParentVersion();
  }
  // Valid hints contain only scalar fields. Reject deeper shapes before JSONB parsing.
  if (input.hints?.some(isNestedHint)) throw invalidHints();

  const send = source === "send" || source === "reupload";
  const row = {
    kind: "chapter_version",
    chapter_id: chapter.id,
    content: input.content,
    source,
    parent_version: input.parent_version,
    hints: input.hints,
    ...(send ? { activate: true } : {}),
  };
  const { ids: [versionId] } = await commitChapterRow(
    client, actorId, chapter, send ? "chapter.send" : "chapter.version.append", row,
  );
  if (!versionId) throw new Error("Chapter commit returned no version ID");

  const { rows: [version] } = await client.query<Omit<VersionRow, "l_seq"> & { l_seq: string }>(
    `SELECT id, chapter_id, version_no, source, text_hash, hints_hash, parent_version, l_seq
     FROM chapter_versions WHERE id = $1`,
    [versionId],
  );
  if (!version) throw new Error("Chapter commit returned a missing version");

  return {
    chapter: await readChapterRow(client, chapter.id),
    version: { ...version, version_no: Number(version.version_no), l_seq: Number(version.l_seq) },
    active_version_id: await readActiveVersionId(client, chapter.id),
  };
}

export function appendVersion(
  pool: Pool,
  actorId: string,
  chapter: ChapterRef,
  input: ChapterVersionInput & { source: "draft_edit" | "import" },
): Promise<VersionWritten> {
  return corpusTransaction(pool, "BEGIN", (client) =>
    writeVersion(client, actorId, chapter, input, input.source),
  );
}

export function sendChapter(
  pool: Pool,
  actorId: string,
  chapter: ChapterRef,
  input: ChapterVersionInput,
): Promise<VersionWritten> {
  return corpusTransaction(pool, "BEGIN", async (client) => {
    await client.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const source = (await readActiveVersionId(client, chapter.id)) === null ? "send" : "reupload";
    return writeVersion(client, actorId, chapter, input, source);
  });
}

export function activateVersion(
  pool: Pool,
  actorId: string,
  chapter: ChapterRef,
  versionId: string | null,
): Promise<ActivationWritten> {
  return corpusTransaction(pool, "BEGIN", async (client) => {
    if (versionId !== null && !await chapterHasVersion(client, chapter.id, versionId)) {
      throw new AppError(404, "not_found", "Version not found");
    }
    const { l_seq } = await commitChapterRow(
      client, actorId, chapter, "chapter.activate",
      { kind: "chapter_active", chapter_id: chapter.id, version_id: versionId },
    );
    return {
      chapter: await readChapterRow(client, chapter.id),
      active_version_id: await readActiveVersionId(client, chapter.id),
      l_seq: Number(l_seq),
    };
  });
}

export type ChapterListItem = ChapterRow & {
  title: string | null;
  word_count: number;
  version_id: string | null;
  active_version_id: string | null;
  sync: ChapterSync;
};

export type BookChapters = { chapters: ChapterListItem[] };

export type HistoryItem = VersionRow & { at: string; word_count: number; snapshot: NamedSnapshot | null; can_name_snapshot: boolean };

export type ChapterHistory = {
  chapter: ChapterRow;
  active_version_id: string | null;
  versions: HistoryItem[];
};

const versionWordCount = `COALESCE((
  SELECT sum(axis_word_count(b.text))
  FROM blocks AS b WHERE b.version_id = v.id AND b.kind IN ('paragraph', 'heading')
), 0)`;

export function listBookChapters(pool: Pool, bookId: string): Promise<ChapterListItem[]>;
export function listBookChapters(pool: Pool, bookId: string, ownerId: string): Promise<ChapterListItem[] | null>;
export function listBookChapters(
  pool: Pool,
  bookId: string,
  ownerId?: string,
): Promise<ChapterListItem[] | null> {
  return corpusTransaction(pool, readOnlyTransaction, async (client) => {
    if (ownerId !== undefined && !await findOwnedBook(client, ownerId, bookId)) return null;

    const { rows } = await client.query<Omit<ChapterListItem, "word_count" | "sync"> & {
      word_count: string;
      latest_text_hash: string | null;
      head_text_hash: string | null;
      active_text_hash: string | null;
      pulled_from: string | null;
    }>(
      `SELECT c.id, c.book_id, c.order_key, v.id AS version_id, opening.text AS title,
              active.version_id AS active_version_id,
              v.text_hash AS latest_text_hash,
              (SELECT encode(sha256(convert_to(axis_fold(d.content), 'UTF8')), 'hex')
               FROM chapter_drafts AS d WHERE d.chapter_id = c.id) AS head_text_hash,
              book_version.text_hash AS active_text_hash,
              (SELECT p.book_version FROM chapter_pullbacks AS p WHERE p.chapter_id = c.id) AS pulled_from,
              ${versionWordCount} AS word_count
       FROM chapters AS c
       LEFT JOIN LATERAL (
         SELECT id, text_hash FROM chapter_versions WHERE chapter_id = c.id ORDER BY version_no DESC LIMIT 1
       ) AS v ON true
       LEFT JOIN LATERAL (
         SELECT a.version_id FROM chapter_active AS a WHERE a.chapter_id = c.id
         ORDER BY a.since_l DESC LIMIT 1
       ) AS active ON true
       LEFT JOIN chapter_versions AS book_version ON book_version.id = active.version_id
       LEFT JOIN blocks AS opening ON opening.version_id = v.id AND opening.ordinal = 1 AND opening.kind = 'heading'
       WHERE c.book_id = $1
       ORDER BY c.order_key COLLATE "C" ASC, c.id COLLATE "C" ASC`,
      [bookId],
    );
    return rows.map(({ latest_text_hash, head_text_hash, active_text_hash, pulled_from, word_count, ...item }) => ({
      ...item,
      word_count: Number(word_count),
      sync: computeSync({
        activeVersionId: item.active_version_id,
        activeTextHash: active_text_hash,
        draftTextHash: head_text_hash ?? latest_text_hash,
        pulledFrom: pulled_from,
      }),
    }));
  });
}

export function getChapterHistory(pool: Pool, chapter: ChapterRef): Promise<ChapterHistory>;
export function getChapterHistory(pool: Pool, chapterId: string, ownerId: string): Promise<ChapterHistory | null>;
export function getChapterHistory(
  pool: Pool,
  ...target: [chapter: ChapterRef] | [chapterId: string, ownerId: string]
): Promise<ChapterHistory | null> {
  return corpusTransaction(pool, readOnlyTransaction, async (client) => {
    const ref = target.length === 2 ? await findOwnedChapter(client, target[1], target[0]) : target[0];
    if (!ref) return null;

    const chapter = await readChapterRow(client, ref.id);
    const activeVersionId = await readActiveVersionId(client, ref.id);
    const { rows } = await client.query<Omit<HistoryItem, "l_seq" | "at" | "word_count"> & {
      l_seq: string; at: Date; word_count: string;
    }>(
      `SELECT v.id, v.chapter_id, v.version_no, v.source, v.text_hash, v.hints_hash,
              v.parent_version, v.l_seq, l.at, ${versionWordCount} AS word_count,
              CASE WHEN nc.version_id IS NULL THEN NULL ELSE jsonb_build_object(
                'chapter_id', nc.chapter_id, 'version_id', nc.version_id, 'kind', nc.kind,
                'name', nc.label, 'l_seq', nc.l_seq, 'pack_pins', nc.pack_pins,
                'created_at', to_char(nc.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) END AS snapshot,
              (nc.version_id IS NULL AND book.status <> 'released' AND v.source = 'draft_edit'
                AND l.op = 'chapter.version.append' AND ${versionWordCount} > 0) AS can_name_snapshot
       FROM chapter_versions AS v
       JOIN ledger AS l ON l.series_id = v.series_id AND l.l_seq = v.l_seq
       JOIN chapters c ON c.id = v.chapter_id
       JOIN books book ON book.id = c.book_id
       LEFT JOIN named_cuts nc ON nc.chapter_id = v.chapter_id AND nc.version_id = v.id
       WHERE v.chapter_id = $1
       ORDER BY v.version_no DESC`,
      [ref.id],
    );

    return {
      chapter,
      active_version_id: activeVersionId,
      versions: rows.map((row) => ({
        ...row,
        version_no: Number(row.version_no),
        l_seq: Number(row.l_seq),
        at: row.at.toISOString(),
        word_count: Number(row.word_count),
      })),
    };
  });
}
