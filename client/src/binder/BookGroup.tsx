import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createChapter, listBookChapters, pullBackChapter } from "../api/endpoints";
import type { BookRow, ChapterListItem } from "../api/types";
import { copy } from "../copy";
import { AxisMotif, ChevronGlyph } from "../glyphs";
import { canPullBack, ChapterRow } from "./ChapterRow";

type ChapterList =
  | { state: "loading" | "failed" }
  | { state: "ready"; items: ChapterListItem[] };

type GroupState = {
  list: ChapterList;
  expanded: boolean;
  adding: boolean;
  addFailed: boolean;
  pullBackReadFailed: boolean;
};

type Props = {
  book: BookRow;
  initiallyExpanded: boolean;
  refreshers: Set<() => void>;
  openChapterId?: string | null;
  locked?: boolean;
  onOpenChapter?: (chapterId: string) => void;
  refreshToken?: number;
};

export function usePullBackController() {
  const [pending, setPending] = useState<string | null>(null);
  const [failureBookId, setFailureBookId] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  return {
    pending,
    failureBookId,
    setFailureBookId,
    begin(id: string) {
      if (busy.current) return false;
      busy.current = true;
      setPending(id);
      setFailureBookId(null);
      return true;
    },
    end() {
      busy.current = false;
      if (mounted.current) setPending(null);
    },
  };
}

export const PullBackContext = createContext<ReturnType<typeof usePullBackController> | null>(null);

export function BookGroup({ book, initiallyExpanded, refreshers, openChapterId = null, locked = false, onOpenChapter, refreshToken = 0 }: Props) {
  const localPullBack = usePullBackController();
  const pullBack = useContext(PullBackContext) ?? localPullBack;
  const [view, setView] = useState<GroupState>({
    list: { state: "loading" },
    expanded: initiallyExpanded,
    adding: false,
    addFailed: false,
    pullBackReadFailed: false,
  });
  const current = useRef(view);
  const latestRead = useRef(0);
  const mounted = useRef(false);
  const previousToken = useRef(refreshToken);
  const pendingRefresh = useRef(false);
  const actions = useRef({ locked, onOpenChapter, openChapterId });
  actions.current = { locked, onOpenChapter, openChapterId };
  const chapterList = useRef<HTMLOListElement>(null);
  const focusAfterRead = useRef<HTMLButtonElement | null>(null);
  const openedByPullBack = useRef<string | null>(null);

  useLayoutEffect(() => {
    const target = focusAfterRead.current;
    focusAfterRead.current = null;
    if (target?.isConnected && document.activeElement === document.body) target.focus();
  }, [view]);

  const update = useCallback((patch: Partial<GroupState>) => {
    current.current = { ...current.current, ...patch };
    setView(current.current);
  }, []);

  const read = useCallback(async (
    blocking: boolean,
    write?: { failed: boolean; previousCount: number },
    settlePullBack?: (items: ChapterListItem[]) => void,
  ) => {
    const number = ++latestRead.current;
    if (blocking) update({ list: { state: "loading" } });
    let items: ChapterListItem[];
    try {
      items = await listBookChapters(book.id);
    } catch {
      if (mounted.current && latestRead.current === number && (write || !current.current.adding)) {
        if (settlePullBack && current.current.list.state === "ready") {
          // Keep the last list available for manual retry after an inconclusive settle read.
          update({ pullBackReadFailed: true });
        } else {
          update({ list: { state: "failed" }, adding: false, addFailed: false, pullBackReadFailed: false });
        }
      }
      return;
    }
    if (mounted.current) settlePullBack?.(items);
    if (mounted.current && latestRead.current === number && (write || !current.current.adding)) {
      const focused = document.activeElement;
      if (focused?.matches('[data-part="chapter-pull-back"]') && chapterList.current?.contains(focused)) {
        const row = focused.parentElement;
        const next = items.find(({ id }) => id === row?.dataset.chapterId);
        if (next && !canPullBack(next) && openedByPullBack.current !== next.id) {
          focusAfterRead.current = row?.querySelector('[data-part="chapter-open"]') ?? null;
        }
      }
      const previous = current.current.list;
      const addFailed = write ? write.failed && items.length <= write.previousCount
        : current.current.addFailed && (previous.state === "ready" ? items.length <= previous.items.length : items.length === 0);
      update({ list: { state: "ready", items }, adding: false, addFailed, pullBackReadFailed: false });
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

  useEffect(() => {
    if (previousToken.current === refreshToken) return;
    previousToken.current = refreshToken;
    const { expanded, adding, list } = current.current;
    if (!expanded || list.state === "loading" || (list.state === "ready" && list.items.length === 0)) return;
    if (adding) { pendingRefresh.current = true; return; }
    void read(list.state !== "ready");
  }, [refreshToken, read]);

  function toggle() {
    const expanded = !current.current.expanded;
    update({ expanded });
    if (expanded && !current.current.adding) void read(current.current.list.state !== "ready");
  }

  async function addChapter(first: boolean) {
    const { expanded, adding, list } = current.current;
    if (!expanded || adding || actions.current.locked || list.state !== "ready" || (list.items.length === 0) !== first) return;
    const previousCount = list.items.length;
    latestRead.current++;
    update({ adding: true, addFailed: false });
    let failed = false;
    let created;
    try {
      created = await createChapter(book.id, "");
    } catch {
      failed = true;
    }
    if (!mounted.current) return;
    if (created) actions.current.onOpenChapter?.(created.chapter.id);
    await read(first, { failed, previousCount });
    if (!mounted.current || !pendingRefresh.current) return;
    pendingRefresh.current = false;
    const state = current.current;
    if (state.expanded && state.list.state !== "loading") void read(state.list.state !== "ready");
  }

  async function pullBackItem(item: ChapterListItem) {
    if (!current.current.expanded || actions.current.locked || !pullBack.begin(item.id)) return;

    const openChapter = () => {
      const { locked, openChapterId, onOpenChapter } = actions.current;
      if (!mounted.current || !current.current.expanded || locked || openChapterId === item.id || !onOpenChapter) return;
      openedByPullBack.current = item.id;
      onOpenChapter(item.id);
    };

    try {
      let failed = false;
      try {
        await pullBackChapter(item.id);
      } catch {
        failed = true;
      }
      if (!mounted.current || !current.current.expanded) return;

      if (failed) pullBack.setFailureBookId(book.id);
      const settled = read(false, undefined, (items) => {
        if (failed && items.some(({ id, sync }) => id === item.id && sync?.state === "being_revised")) {
          pullBack.setFailureBookId(null);
          openChapter();
        }
      });
      if (!failed) openChapter();
      await settled;
    } finally {
      openedByPullBack.current = null;
      pullBack.end();
    }
  }

  const { list, expanded, adding, addFailed, pullBackReadFailed } = view;
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
        {(list.state === "failed" || pullBackReadFailed) && (
          <div className="ax-status ax-binder-status" role="alert" data-part="read-failure">
            <div>{copy["binder.readFailed"]}</div>
            <button className="ax-button ax-button--secondary" type="button" data-part="try-again"
              onClick={() => {
                if (current.current.list.state === "failed") void read(true);
                else if (current.current.pullBackReadFailed) void read(false);
              }}>
              {copy["binder.tryAgain"]}
            </button>
          </div>
        )}
        {state === "empty" && (
          <div data-part="empty" className="ax-binder-empty">
            <AxisMotif />
            <button className="ax-button ax-button--secondary ax-button--wide" type="button"
              data-part="add-first-scene" aria-disabled={adding || locked || undefined} onClick={() => { void addChapter(true); }}>
              {adding ? copy["binder.adding"] : copy["binder.addFirstScene"]}
            </button>
            {addFailed && (
              <p className="ax-status ax-binder-status" role="alert" data-part="add-failure">
                {copy["binder.addFailed"]}
              </p>
            )}
          </div>
        )}
        {list.state === "ready" && state !== "empty" && (
          <ol ref={chapterList} className="ax-binder-chapter-list" data-part="chapter-list">
            {list.items.map((item, index) => <ChapterRow key={item.id} item={item} position={index + 1}
              current={item.id === openChapterId} locked={locked} onOpen={() => actions.current.onOpenChapter?.(item.id)}
              onPullBack={() => { void pullBackItem(item); }} pendingPullBack={pullBack.pending} />)}
          </ol>
        )}
        {pullBack.failureBookId === book.id && (
          <p className="ax-binder__pullback-failure" data-part="pull-back-failure" role="status">{copy["binder.pullBackFailed"]}</p>
        )}
        {state === "ready" && (
          <>
            <button type="button" data-part="add-chapter" className="ax-button ax-button--secondary"
              aria-disabled={adding || locked} onClick={() => { void addChapter(false); }}>
              {adding ? copy["binder.adding"] : copy["binder.addChapter"]}
            </button>
            {addFailed && <p role="alert" data-part="add-failure">{copy["binder.addChapterFailed"]}</p>}
          </>
        )}
      </div>
    </li>
  );
}
