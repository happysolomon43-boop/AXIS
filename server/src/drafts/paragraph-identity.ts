import type { BlockRow } from "../corpus/repo.js";
import type { DraftBlock } from "./repository.js";

export type WorkingDraftBlock = DraftBlock & { block_uid: string | null };

export function projectDraftBlockUids(versionContent: string, headContent: string,
  versionBlocks: readonly BlockRow[], draftBlocks: readonly DraftBlock[]): WorkingDraftBlock[] {
  if (versionContent === headContent) {
    if (versionBlocks.length !== draftBlocks.length || draftBlocks.some((block, i) => {
      const stored = versionBlocks[i]!;
      return stored.ordinal !== block.ordinal || stored.kind !== block.kind || stored.text !== block.text;
    })) throw new Error("Inconsistent block segmentation");
    return draftBlocks.map(({ ordinal, kind, text }, i) => ({
      ordinal, kind, text, block_uid: kind === "paragraph" ? versionBlocks[i]!.block_uid : null,
    }));
  }
  const stored = new Map<string, { count: number; uid: string }>();
  const counts = new Map<string, number>();
  for (const block of versionBlocks) if (block.kind === "paragraph") {
    const prior = stored.get(block.text);
    stored.set(block.text, { count: (prior?.count ?? 0) + 1, uid: block.block_uid });
  }
  for (const block of draftBlocks) if (block.kind === "paragraph") counts.set(block.text, (counts.get(block.text) ?? 0) + 1);
  return draftBlocks.map(({ ordinal, kind, text }) => {
    const match = stored.get(text);
    return { ordinal, kind, text, block_uid: kind === "paragraph" && match?.count === 1 && counts.get(text) === 1 ? match.uid : null };
  });
}
