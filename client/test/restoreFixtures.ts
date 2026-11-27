import type { ChapterHistory, HistoryItem, RestoreWritten } from "../src/api/types";
import { chapterA, histA, histB, histC, internalEnvelope, versionNotFoundEnvelope } from "./historyFixtures";

export { internalEnvelope, versionNotFoundEnvelope };

export const hashA = "a".repeat(64);
export const hashB = "b".repeat(64);
export const hashC = "c".repeat(64);
export const hashD = "d".repeat(64);
export const zeroHash = "0".repeat(64);

export const rowA: HistoryItem = { ...histA, text_hash: hashA };
export const rowB: HistoryItem = { ...histB, text_hash: hashB };
export const rowC: HistoryItem = { ...histC, text_hash: hashC };
export const historyH3: ChapterHistory = { chapter: chapterA, active_version_id: rowC.id, versions: [rowC, rowB, rowA] };

export const restoreRowB: HistoryItem = {
  id: "ver_00000000000e", chapter_id: chapterA.id, version_no: 4, source: "restore", text_hash: hashB,
  hints_hash: zeroHash, parent_version: rowC.id, l_seq: 4, at: "2026-10-25T08:00:00.000Z", word_count: 3,
};
export const checkpointRow: HistoryItem = {
  ...restoreRowB, id: "ver_00000000000f", source: "checkpoint", text_hash: hashD,
  at: "2026-10-25T07:59:00.000Z", word_count: 2,
};
export const restoreRowBCp: HistoryItem = {
  ...restoreRowB, id: "ver_000000000010", version_no: 5, parent_version: checkpointRow.id, l_seq: 5,
};

export const historyAfterRestore: ChapterHistory = { ...historyH3, versions: [restoreRowB, ...historyH3.versions] };
export const historyAfterCheckpoint: ChapterHistory = {
  ...historyH3, versions: [restoreRowBCp, checkpointRow, ...historyH3.versions],
};

export const historyAfterCheckpointNamed: ChapterHistory = {
  ...historyAfterCheckpoint,
  versions: historyAfterCheckpoint.versions.map((row) => ({
    ...row,
    snapshot: row.id === checkpointRow.id ? {
      chapter_id: row.chapter_id, version_id: row.id, kind: "snapshot", name: "Before restore",
      l_seq: row.l_seq, pack_pins: {}, created_at: "2026-11-20T10:00:00.000Z",
    } : null,
    snapshot_lifecycle: row.id === checkpointRow.id ? {
      snapshot_id: "11111111-1111-4111-8111-111111111111",
      state_token: "22222222-2222-4222-8222-222222222222",
      previous_token: null,
    } : null,
    can_name_snapshot: false,
  })),
};

function written(
  { at: _at, word_count: _count, ...version }: HistoryItem, checkpoint_version_id: string | null,
): { status: 201; body: RestoreWritten } {
  return { status: 201, body: { chapter: chapterA, version, active_version_id: rowC.id, checkpoint_version_id } };
}

export const restoreReply = written(restoreRowB, null);
export const restoreReplyCp = written(restoreRowBCp, checkpointRow.id);
export const restorePath = `/api/chapters/${chapterA.id}/restore`;
