import type { Pool, PoolClient } from "pg";
import { findOwnedChapter, readActiveVersionId, readChapterRow, readVersionRow, type ChapterRef, type VersionWritten } from "../corpus/repo.js";
import { readOnlyTransaction, transaction } from "../db/transaction.js";
import { AppError } from "../errors.js";
import { uuidPattern } from "../named-cuts/capture.js";
import { readChapterSync } from "../sync/read.js";
import type { ChapterSync } from "../sync/state.js";

export type WriteOperation = "save" | "send" | "restore" | "keep_mine";
export type WriteResult = VersionWritten & {
  request_id: string;
  operation: WriteOperation;
  source_version_id: string | null;
  checkpoint_version_id: string | null;
  sync?: ChapterSync;
  current: { version_id: string; revision: number; active_version_id: string | null; sync: ChapterSync };
};
type Receipt = {
  chapter_id: string;
  request_id: string;
  request_hash: string;
  operation: WriteOperation;
  version_id: string;
  active_version_id: string | null;
  source_version_id: string | null;
  checkpoint_version_id: string | null;
};
type Effect = Pick<Receipt, "version_id" | "active_version_id"> &
  Partial<Pick<Receipt, "source_version_id" | "checkpoint_version_id">>;

export async function readWriteBase(client: PoolClient, chapterId: string) {
  const { rows: [base] } = await client.query<{
    id: string; content: string; revision: number; head_content: string | null; head_base: string | null;
  }>(
    `SELECT v.id, v.content, COALESCE(d.revision, 0) AS revision, d.content AS head_content, d.base_version AS head_base
     FROM chapter_versions v LEFT JOIN chapter_drafts d ON d.chapter_id = v.chapter_id
     WHERE v.chapter_id = $1 ORDER BY v.version_no DESC LIMIT 1`,
    [chapterId],
  );
  if (base && base.head_base !== null && base.head_base !== base.id) throw new Error("Invalid draft base");
  return base;
}

async function receiptFor(client: PoolClient, chapterId: string, requestId: string) {
  const { rows: [receipt] } = await client.query<Receipt>(
    "SELECT * FROM chapter_write_receipts WHERE chapter_id = $1 AND request_id = $2",
    [chapterId, requestId],
  );
  return receipt;
}

async function project(client: PoolClient, receipt: Receipt): Promise<WriteResult> {
  const chapterId = receipt.chapter_id;
  const version = await readVersionRow(client, receipt.version_id);
  const current = await readWriteBase(client, chapterId);
  if (!current || version.chapter_id !== chapterId) throw new Error("Invalid write receipt references");
  const sync = await readChapterSync(client, chapterId);
  return {
    chapter: await readChapterRow(client, chapterId),
    version,
    request_id: receipt.request_id,
    operation: receipt.operation,
    active_version_id: receipt.active_version_id,
    source_version_id: receipt.source_version_id,
    checkpoint_version_id: receipt.checkpoint_version_id,
    ...(receipt.operation === "save" ? { sync } : {}),
    current: {
      version_id: current.id,
      revision: current.revision,
      active_version_id: await readActiveVersionId(client, chapterId),
      sync,
    },
  };
}

export function commitChapterWrite(
  pool: Pool, actor: string, chapter: ChapterRef, operation: WriteOperation, requestId: string,
  semanticInput: object, commit: (client: PoolClient) => Promise<Effect>,
) {
  return transaction(pool, "BEGIN", async (client) => {
    const locked = await client.query("SELECT id FROM series WHERE id = $1 FOR NO KEY UPDATE", [chapter.series_id]);
    const owned = await findOwnedChapter(client, actor, chapter.id);
    if (!locked.rowCount || owned?.series_id !== chapter.series_id || owned.book_id !== chapter.book_id) {
      throw new AppError(404, "not_found", "Chapter not found");
    }
    const { rows: [fingerprint] } = await client.query<{ hash: string }>(
      "SELECT encode(sha256(convert_to(jsonb_build_array($1::text, $2::jsonb)::text, 'UTF8')), 'hex') AS hash",
      [operation, JSON.stringify(semanticInput)],
    );
    const hash = fingerprint!.hash;
    const prior = await receiptFor(client, chapter.id, requestId);
    if (prior) {
      if (prior.request_hash !== hash) {
        throw new AppError(409, "write_conflict", "Write request ID already used", { reason: "request_mismatch" });
      }
      return { status: 200 as const, result: await project(client, prior) };
    }

    const effect = await commit(client);
    const { rows: [receipt] } = await client.query<Receipt>(
      `INSERT INTO chapter_write_receipts
         (chapter_id, request_id, request_hash, operation, version_id, active_version_id, source_version_id, checkpoint_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [chapter.id, requestId, hash, operation, effect.version_id, effect.active_version_id,
        effect.source_version_id ?? null, effect.checkpoint_version_id ?? null],
    );
    if (!receipt) throw new Error("Missing write receipt");
    return { status: 201 as const, result: await project(client, receipt) };
  });
}

export function getWriteReceipt(pool: Pool, actor: string, chapterId: string, requestId: string) {
  return transaction(pool, readOnlyTransaction, async (client) => {
    if (chapterId.length > 64 || chapterId.includes("\0") || !await findOwnedChapter(client, actor, chapterId)) {
      throw new AppError(404, "not_found", "Chapter not found");
    }
    if (requestId.length !== 36 || !new RegExp(uuidPattern).test(requestId)) {
      throw new AppError(400, "validation_failed", "Request validation failed", {
        errors: [{ path: "/requestId", message: "must be a lowercase UUID v4" }],
      });
    }
    const receipt = await receiptFor(client, chapterId, requestId);
    return receipt ? project(client, receipt) : null;
  });
}
