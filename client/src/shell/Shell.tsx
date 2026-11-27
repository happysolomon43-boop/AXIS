import "./shell.css";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SeriesTree } from "../api/types";
import { Binder } from "../binder/Binder";
import { copy } from "../copy";
import { Draft } from "../draft/Draft";
import { AxisMark, BinderGlyph } from "../glyphs";
import { History, type OnRestored, type RestoreAttempt } from "../history/History";
import { Drawer } from "./Drawer";

export function Shell({ tree }: { tree: SeriesTree }) {
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

  const onLockChange = useCallback((value: boolean) => {
    lockedRef.current = value;
    setLocked(value);
  }, []);
  const onOpenChapter = useCallback((id: string) => {
    if (lockedRef.current || openChapterIdRef.current === id) return;
    documentChanges.current++;
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
      if (event.code === "KeyS" && !event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey)) event.preventDefault();
      if (event.code === "Backslash" && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        toggleBinder();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleBinder]);

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
            else setHistoryOpen(true);
          }}>
          {copy["shell.historyDoor"]}
          {historyOpen && <span className="ax-history-door__underline" data-part="history-door-underline" aria-hidden="true" />}
        </button>}
      </header>
      <aside className="ax-binder-region" data-region="binder" aria-label={copy["shell.binderRegion"]}
        id={binderId} ref={binder} hidden={!shown}>
        <Binder tree={tree} openChapterId={openChapterId} locked={locked} onOpenChapter={onOpenChapter} onChapterPullBackLanded={onChapterPullBackLanded} refreshToken={refreshToken} />
      </aside>
      <main className="ax-text-region" data-region="text" aria-label={copy["shell.textRegion"]}>
        {openChapterId !== null && <Draft key={openChapterId} chapterId={openChapterId} reloadToken={reload.token} restoredVersionId={reload.version}
          onDocumentChange={() => { documentChanges.current++; }} syncRefreshToken={syncRefreshToken} onLockChange={onLockChange} onWritten={onWritten} />}
      </main>
      {historyOpen && openChapterId !== null &&
        <Drawer title={copy["history.title"]} onClose={closeHistory}>
          <History key={openChapterId} seriesId={tree.series.id} chapterId={openChapterId} refreshToken={historyRefreshToken + syncRefreshToken} locked={locked}
            pendingRestores={pendingRestores.current} onRestoreStart={() => startRestore(openChapterId)} />
        </Drawer>}
    </div>
  );
}
