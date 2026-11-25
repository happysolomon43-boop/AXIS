export const AUTOSAVE = { idleMs: 2000, minGapMs: 5000, hardMs: 30000 };

type Timing = {
  lastChangeAt: number;
  dirtySince: number;
  lastPutStartAt: number | null;
  failedAt: number | null;
};

export function fireAt({ lastChangeAt, dirtySince, lastPutStartAt, failedAt }: Timing): number {
  const base = Math.min(lastChangeAt + AUTOSAVE.idleMs, dirtySince + AUTOSAVE.hardMs);
  const next = lastPutStartAt === null ? base : Math.max(base, lastPutStartAt + AUTOSAVE.minGapMs);
  return failedAt !== null && failedAt >= lastChangeAt ? Math.max(next, failedAt + AUTOSAVE.hardMs) : next;
}
