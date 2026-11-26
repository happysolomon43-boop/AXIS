export type ChapterSync = {
  state: "draft_only" | "in_book" | "edited" | "being_revised";
  same: boolean;
};

type SyncInputs = {
  activeVersionId: string | null;
  activeTextHash: string | null;
  draftTextHash: string | null;
  pulledFrom: string | null;
};

export function computeSync({ activeVersionId, activeTextHash, draftTextHash, pulledFrom }: SyncInputs): ChapterSync {
  if (activeVersionId === null) return { state: "draft_only", same: false };
  const same = activeTextHash !== null && draftTextHash !== null && activeTextHash === draftTextHash;
  if (pulledFrom === activeVersionId) return { state: "being_revised", same };
  return same ? { state: "in_book", same: true } : { state: "edited", same: false };
}
