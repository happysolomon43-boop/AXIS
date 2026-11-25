import "./open.css";
import { copy } from "../copy";
import type { ChapterListItem } from "../api/types";
import { chapterRowName, formatWordCount, versionChip } from "./format";

export function ChapterRow({ item, position, current = false, locked = false, onOpen }: {
  item: ChapterListItem; position: number; current?: boolean; locked?: boolean; onOpen?: () => void;
}) {
  const chip = versionChip(item);
  return (
    <li className="ax-binder-chapter" data-part="chapter" data-chapter-id={item.id}
      aria-label={chapterRowName(position, item.title)}>
      <span className="ax-binder-numeral" data-part="numeral">{position}</span>
      {item.title !== null && (
        <span className="ax-binder-chapter-title" data-part="title" title={item.title}>{item.title}</span>
      )}
      <span className="ax-binder-count" data-part="count">{formatWordCount(item.word_count)}</span>
      {chip !== null && <span className="ax-binder-chip" data-part="chip">{chip}</span>}
      <button type="button" data-part="chapter-open" aria-label={`${copy["binder.openPrefix"]} ${chapterRowName(position, item.title)}`}
        aria-current={current ? "true" : undefined} aria-disabled={locked}
        onClick={() => { if (!locked && !current) onOpen?.(); }}>
        {current && <span data-part="current-mark" aria-hidden="true" />}
      </button>
    </li>
  );
}
