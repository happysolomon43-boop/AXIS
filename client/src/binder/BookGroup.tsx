import { useCallback, useEffect, useRef, useState } from "react";
import { createChapter, listBookChapters } from "../api/endpoints";
import type { BookRow, ChapterListItem } from "../api/types";
import { copy } from "../copy";
import { AxisMotif, ChevronGlyph } from "../glyphs";
import { ChapterRow } from "./ChapterRow";

type ChapterList =
  | { state: "loading" | "failed" }
  | { state: "ready"; items: ChapterListItem[] };

type GroupState = {
  list: ChapterList;
  expanded: boolean;
  adding: boolean;
  addFailed: boolean;
};

type Props = {
  book: BookRow;
  initiallyExpanded: boolean;
  refreshers: Set<() => void>;
};

export function BookGroup({ book, initiallyExpanded, refreshers }: Props) {
  const [view, setView] = useState<GroupState>({
    list: { state: "loading" },
    expanded: initiallyExpanded,
    adding: false,
    addFailed: false,
  });
  const current = useRef(view);
  const latestRead = useRef(0);
  const mounted = useRef(false);

  const update = useCallback((patch: Partial<GroupState>) => {
    current.current = { ...current.current, ...patch };
    setView(current.current);
  }, []);

  const read = useCallback(async (blocking: boolean, write?: { failed: boolean }) => {
    const number = ++latestRead.current;
    if (write) {
      update({ list: { state: "loading" }, adding: false, addFailed: write.failed });
    } else if (blocking) {
      update({ list: { state: "loading" } });
    }

    let items: ChapterListItem[];
    try {
      items = await listBookChapters(book.id);
    } catch {
      if (mounted.current && latestRead.current === number && !current.current.adding) {
        update({ list: { state: "failed" }, addFailed: false });
      }
      return;
    }
    if (mounted.current && latestRead.current === number && !current.current.adding) {
      update({ list: { state: "ready", items }, addFailed: items.length === 0 && current.current.addFailed });
    }
  }, [book.id, update]);

  useEffect(() => {
    mounted.current = true;
    function refresh() {
      const { expanded, adding, list } = current.current;
      if (expanded && !adding && list.state !== "loading") void read(list.state !== "ready");
    }
    refreshers.add(refresh);
    if (current.current.expanded) void read(true);

    return () => {
      mounted.current = false;
      latestRead.current++;
      refreshers.delete(refresh);
    };
  }, [read, refreshers]);

  function toggle() {
    const expanded = !current.current.expanded;
    update({ expanded });
    if (expanded) void read(current.current.list.state !== "ready");
  }

  async function addFirstScene() {
    const { expanded, adding, list } = current.current;
    if (!expanded || adding || list.state !== "ready" || list.items.length > 0) return;

    // A read started before this write cannot determine the post-write state.
    latestRead.current++;
    update({ adding: true, addFailed: false });
    let failed = false;
    try {
      await createChapter(book.id, "");
    } catch {
      failed = true;
    }
    if (mounted.current) await read(true, { failed });
  }

  const { list, expanded, adding, addFailed } = view;
  const state = list.state === "ready" && list.items.length === 0 ? "empty" : list.state;
  return (
    <li className="ax-binder-book" data-part="book" data-book-id={book.id}>
      <button className="ax-binder-toggle" type="button" data-part="book-toggle" aria-expanded={expanded}
        onClick={toggle}>
        <ChevronGlyph direction={expanded ? "down" : "right"} />
        {book.title}
      </button>
      <div data-part="chapters" data-state={state} hidden={!expanded}>
        {list.state === "loading" && (
          <p className="ax-status ax-binder-status" role="status" data-part="reading">
            {copy["binder.reading"]}
            <span data-part="reading-rule" className="ax-reading-rule" aria-hidden="true" />
          </p>
        )}
        {list.state === "failed" && (
          <div className="ax-status ax-binder-status" role="alert" data-part="read-failure">
            <div>{copy["binder.readFailed"]}</div>
            <button className="ax-button ax-button--secondary" type="button" data-part="try-again"
              onClick={() => { if (current.current.list.state === "failed") void read(true); }}>
              {copy["binder.tryAgain"]}
            </button>
          </div>
        )}
        {list.state === "ready" && (list.items.length === 0 ? (
          <div data-part="empty" className="ax-binder-empty">
            <AxisMotif />
            <button className="ax-button ax-button--secondary ax-button--wide" type="button"
              data-part="add-first-scene" aria-disabled={adding || undefined} onClick={addFirstScene}>
              {adding ? copy["binder.adding"] : copy["binder.addFirstScene"]}
            </button>
            {addFailed && (
              <p className="ax-status ax-binder-status" role="alert" data-part="add-failure">
                {copy["binder.addFailed"]}
              </p>
            )}
          </div>
        ) : (
          <ol className="ax-binder-chapter-list" data-part="chapter-list">
            {list.items.map((item, index) => <ChapterRow key={item.id} item={item} position={index + 1} />)}
          </ol>
        ))}
      </div>
    </li>
  );
}
