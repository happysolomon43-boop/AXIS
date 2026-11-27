import "./shell.css";
import "../styles/compare.css";
import type { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SeriesTree } from "../api/types";
import { Binder } from "../binder/Binder";
import { copy } from "../copy";
import { Draft } from "../draft/Draft";
import { AxisMark, BinderGlyph, ChevronGlyph } from "../glyphs";
import { ComparePage, type CompareChoice } from "../history/ComparePage";
import { History, type OnRestored, type RestoreAttempt } from "../history/History";
import { Drawer } from "./Drawer";

type LiveEditor = { chapterId: string; view: EditorView; composing: boolean; detach: () => void };
type CompareSession = {
  launch: number;
  chapterId: string;
  versions: readonly CompareChoice[];
  a: string;
  b: string | null;
  backLabel: string;
  scrollTop: number;
};

function currentBlock(view: EditorView): number {
  const { doc, selection } = view.state;
  return Math.min(doc.resolve(selection.head).index(0) + 1, doc.childCount) || 1;
}

function usePageAppearance(view: EditorView | undefined) {
  const leaf = view?.dom.closest<HTMLElement>(".ax-leaf");
  const [appearance, setAppearance] = useState({ theme: "light", profile: "literary" });
  useLayoutEffect(() => {
    if (!leaf) return;
    function update() {
      setAppearance({ theme: leaf?.dataset.theme ?? "light", profile: leaf?.dataset.profile ?? "literary" });
    }
    update();
    const observer = new MutationObserver(update);
    observer.observe(leaf, { attributes: true, attributeFilter: ["data-theme", "data-profile"] });
    return () => observer.disconnect();
  }, [leaf]);
  return appearance;
}

export function Shell({ tree }: { tree: SeriesTree }) {
  return <MountedShell key={tree.series.owner_id} tree={tree} />;
}

function MountedShell({ tree }: { tree: SeriesTree }) {
  const [shown, setShown] = useState(true);
  const [openChapterId, setOpenChapterId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyDoor = useRef<HTMLButtonElement>(null);
  const [locked, setLocked] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [reload, setReload] = useState<{ token: number; version?: string }>({ token: 0 });
  const documentChanges = useRef(0);
  const pendingRestores = useRef(new Map<string, RestoreAttempt>());
  const [syncRefreshToken, setSyncRefreshToken] = useState(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const lockedRef = useRef(false);
  const openChapterIdRef = useRef<string | null>(null);

  const textRegion = useRef<HTMLElement>(null);
  const pageHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<LiveEditor | null>(null);
  const [editor, setEditor] = useState<LiveEditor | null>(null);
  const [session, setSession] = useState<CompareSession | null>(null);
  const sessionRef = useRef<CompareSession | null>(null);
  const launch = useRef(0);
  const returning = useRef<{ session: CompareSession; focusEditor: boolean } | null>(null);
  const appearance = usePageAppearance(session ? editor?.view : undefined);

  function onEditorReady(chapterId: string, view: EditorView) {
    if (openChapterIdRef.current !== chapterId) return;
    editorRef.current?.detach();
    function composition(composing: boolean) {
      const current = editorRef.current;
      if (current?.view !== view) return;
      const next = { ...current, composing };
      editorRef.current = next;
      setEditor(next);
    }
    const onStart = () => composition(true);
    const onEnd = () => composition(false);
    view.dom.addEventListener("compositionstart", onStart);
    view.dom.addEventListener("compositionend", onEnd);
    const next = { chapterId, view, composing: false, detach() {
      view.dom.removeEventListener("compositionstart", onStart);
      view.dom.removeEventListener("compositionend", onEnd);
    } };
    editorRef.current = next;
    setEditor(next);
  }

  function onEditorDispose(view: EditorView) {
    const current = editorRef.current;
    if (current?.view !== view) return;
    current.detach();
    editorRef.current = null;
    if (mounted.current) setEditor(null);
  }

  function openCompare(chapterId: string, versions: readonly CompareChoice[], a: string, b: string | null) {
    const live = editorRef.current;
    if (!mounted.current || openChapterIdRef.current !== chapterId || live?.chapterId !== chapterId
      || live.view.isDestroyed || !live.view.dom.isConnected || !textRegion.current?.contains(live.view.dom)
      || sessionRef.current || lockedRef.current || live.composing || live.view.composing) return false;

    const next = { launch: ++launch.current, chapterId, versions, a, b,
      backLabel: `Back to text · Chapter ${chapterId} · block ${currentBlock(live.view)}`,
      scrollTop: textRegion.current.scrollTop };
    sessionRef.current = next;
    setSession(next);
    setHistoryOpen(false);
    return true;
  }

  function closeCompare(focusEditor: boolean) {
    if (!sessionRef.current) return;
    returning.current = { session: sessionRef.current, focusEditor };
    sessionRef.current = null;
    setSession(null);
  }

  useLayoutEffect(() => {
    if (session) {
      if (textRegion.current) textRegion.current.scrollTop = 0;
      pageHost.current?.querySelector<HTMLElement>('[data-part="heading"]')?.focus({ preventScroll: true });
      return;
    }
    const back = returning.current;
    returning.current = null;
    if (!back || back.session.chapterId !== openChapterIdRef.current) return;
    if (textRegion.current) textRegion.current.scrollTop = back.session.scrollTop;
    if (!back.focusEditor) return;
    const current = editorRef.current;
    if (current?.chapterId === back.session.chapterId && !current.view.isDestroyed && current.view.dom.isConnected) {
      current.view.focus();
    } else {
      historyDoor.current?.focus({ preventScroll: true });
    }
  }, [session]);

  const pageOwnsText = useCallback(() => sessionRef.current !== null, []);
  const compareEditorAvailable = editor !== null && editor.chapterId === openChapterId
    && !editor.view.isDestroyed && editor.view.dom.isConnected && !locked && !editor.composing && !session;

  const onLockChange = useCallback((value: boolean) => {
    lockedRef.current = value;
    setLocked(value);
  }, []);
  const onOpenChapter = useCallback((id: string) => {
    if (lockedRef.current || openChapterIdRef.current === id) return;
    documentChanges.current++;
    sessionRef.current = null;
    returning.current = null;
    setSession(null);
    openChapterIdRef.current = id;
    setOpenChapterId(id);
    onLockChange(false);
  }, [onLockChange]);
  const onChapterPullBackLanded = useCallback((chapterId: string) => {
    if (mounted.current && openChapterIdRef.current === chapterId) {
      setSyncRefreshToken((token) => token + 1);
    }
  }, []);
  const onWritten = useCallback(() => {
    setRefreshToken((token) => token + 1);
    setHistoryRefreshToken((token) => token + 1);
  }, []);
  const current = useRef(true);
  const door = useRef<HTMLButtonElement>(null);
  const binder = useRef<HTMLElement>(null);
  const binderId = useId();

  const toggleBinder = useCallback(() => {
    current.current = !current.current;
    if (!current.current && binder.current?.contains(document.activeElement)) {
      door.current?.focus();
    }
    setShown(current.current);
  }, []);

  function closeHistory() {
    setHistoryOpen(false);
    historyDoor.current?.focus();
  }

  function startRestore(chapterId: string): OnRestored {
    const changes = documentChanges.current;
    return (outcome) => {
      if (!mounted.current) return "kept";
      setRefreshToken((token) => token + 1);
      if (openChapterIdRef.current !== chapterId) return "kept";
      if (lockedRef.current || changes !== documentChanges.current || !outcome.draft_current) return "kept";

      setReload((previous) => ({ token: previous.token + 1, version: outcome.version_id }));
      return "applied";
    };
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!pageOwnsText() && event.code === "KeyS" && !event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey)) event.preventDefault();
      if (event.code === "Backslash" && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        toggleBinder();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageOwnsText, toggleBinder]);

  return (
    <div className="ax-shell" data-surface="shell">
      <header className="ax-strip" data-region="top-strip">
        <span className="ax-wordmark" data-part="wordmark">
          <AxisMark />
          {copy["shell.wordmark"]}
        </span>
        <button
          className="ax-door"
          type="button"
          data-part="binder-door"
          aria-label={copy["shell.binderDoor"]}
          aria-pressed={shown}
          aria-controls={binderId}
          title={copy["shell.binderDoorHint"]}
          ref={door}
          onClick={toggleBinder}
        >
          <BinderGlyph />
          {shown && <span className="ax-door-underline" data-part="door-underline" aria-hidden="true" />}
        </button>
        {openChapterId !== null && <button ref={historyDoor} type="button" className="ax-history-door" data-part="history-door"
          aria-expanded={historyOpen} onClick={() => {
            if (historyOpen) closeHistory();
            else {
              closeCompare(false);
              setHistoryOpen(true);
            }
          }}>
          {copy["shell.historyDoor"]}
          {historyOpen && <span className="ax-history-door__underline" data-part="history-door-underline" aria-hidden="true" />}
        </button>}
      </header>
      <aside className="ax-binder-region" data-region="binder" aria-label={copy["shell.binderRegion"]}
        id={binderId} ref={binder} hidden={!shown}>
        <Binder tree={tree} openChapterId={openChapterId} locked={locked} onOpenChapter={onOpenChapter} onChapterPullBackLanded={onChapterPullBackLanded} refreshToken={refreshToken} />
      </aside>
      <main ref={textRegion} className="ax-text-region" data-region="text" aria-label={copy["shell.textRegion"]}>
        {openChapterId !== null && <div data-part="draft-host" hidden={session !== null}>
          <Draft key={openChapterId} chapterId={openChapterId} reloadToken={reload.token} restoredVersionId={reload.version}
            onDocumentChange={() => { documentChanges.current++; }} syncRefreshToken={syncRefreshToken} onLockChange={onLockChange} onWritten={onWritten}
            onEditorReady={view => onEditorReady(openChapterId, view)} onEditorDispose={onEditorDispose} pageOwnsText={pageOwnsText} />
        </div>}
        {session && <div ref={pageHost} className="ax-compare-host ax-leaf" data-region="page"
          data-theme={appearance.theme} data-profile={appearance.profile} onKeyDown={event => {
            if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
            const target = event.target;
            if (target instanceof HTMLSelectElement && globalThis.CSS?.supports?.("selector(select:open)") && target.matches(":open")) return;
            event.preventDefault();
            closeCompare(true);
          }}>
          <div className="ax-compare-host__header">
            <button type="button" data-part="compare-back" className="ax-compare-host__back" onClick={() => closeCompare(true)}>
              <ChevronGlyph direction="left" size={16} />
              {session.backLabel}
            </button>
          </div>
          <ComparePage key={session.launch} chapterId={session.chapterId} versions={session.versions} a={session.a} b={session.b} />
        </div>}
      </main>
      {historyOpen && openChapterId !== null &&
        <Drawer title={copy["history.title"]} onClose={closeHistory}>
          <History key={openChapterId} seriesId={tree.series.id} chapterId={openChapterId} refreshToken={historyRefreshToken + syncRefreshToken} locked={locked}
            onCompare={openCompare} compareEditorAvailable={compareEditorAvailable}
            pendingRestores={pendingRestores.current} onRestoreStart={() => startRestore(openChapterId)} />
        </Drawer>}
    </div>
  );
}
