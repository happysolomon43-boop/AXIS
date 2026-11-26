import "./open.css";
import { copy } from "../copy";
import type { ChapterListItem } from "../api/types";
import { chapterRowName, formatWordCount, syncChip } from "./format";

export function canPullBack(item: ChapterListItem): boolean {
  return item.sync?.state === "in_book" || item.sync?.state === "edited";
}

export function ChapterRow({ item, position, current = false, locked = false, onOpen, onPullBack, pendingPullBack }: {
  item: ChapterListItem; position: number; current?: boolean; locked?: boolean; onOpen?: () => void;
  onPullBack?: () => void; pendingPullBack?: string | null;
}) {
  const chip = syncChip(item);
  const name = chapterRowName(position, item.title);
  const pullBackInert = locked || Boolean(pendingPullBack);
  return (
    <li className="ax-binder-chapter" data-part="chapter" data-chapter-id={item.id} aria-label={name}>
      <span className="ax-binder-numeral" data-part="numeral">{position}</span>
      {item.title !== null && (
        <span className="ax-binder-chapter-title" data-part="title" title={item.title}>{item.title}</span>
      )}
      <span className="ax-binder-count" data-part="count">{formatWordCount(item.word_count)}</span>
      {chip !== null && <span className="ax-binder-chip ax-binder__sync" data-part="chip">{chip}</span>}
      {canPullBack(item) && (
        <button className="ax-button ax-button--quiet ax-binder__pullback" type="button" data-part="chapter-pull-back"
          aria-label={`${copy["binder.pullBackPrefix"]} ${name}`}
          aria-disabled={pullBackInert || undefined} onClick={() => { if (!pullBackInert) onPullBack?.(); }}>
          {pendingPullBack === item.id ? copy["binder.pullingBack"] : copy["binder.pullBack"]}
        </button>
      )}
      <button type="button" data-part="chapter-open" aria-label={`${copy["binder.openPrefix"]} ${name}`}
        aria-current={current ? "true" : undefined} aria-disabled={locked}
        onClick={() => { if (!locked && !current) onOpen?.(); }}>
        {current && <span data-part="current-mark" aria-hidden="true" />}
      </button>
    </li>
  );
}
