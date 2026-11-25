import "./history.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { getHistory, getVersion } from "../api/endpoints";
import type { ChapterHistory, HistoryItem, VersionText } from "../api/types";
import { copy } from "../copy";
import { formatVersionDate, previewBlocks, sourceWord, wordsLabel } from "./historyFormat";

type Props = { chapterId: string; refreshToken?: number; timeZone?: string };
type List = { state: "loading" | "failed" } | { state: "ready"; history: ChapterHistory; refreshFailed: boolean };
type Selection = { id: string; state: "loading" | "failed" } | { id: string; state: "ready"; text: VersionText };

function VersionDetail({ selection, onRetry }: { selection: Selection; onRetry: () => void }) {
  const lines = selection.state === "ready" ? previewBlocks(selection.text.blocks) : [];
  return (
    <div className="ax-history__detail" data-part="version-detail" data-state={selection.state}>
      {selection.state === "loading" &&
        <p className="ax-history__reading" data-part="version-reading" role="status">{copy["history.versionReading"]}<span className="ax-reading-rule" data-part="reading-rule" aria-hidden="true" /></p>}
      {selection.state === "failed" && <>
        <p className="ax-history__note" data-part="version-failure" role="status">{copy["history.versionFailed"]}</p>
        <button type="button" className="ax-button ax-button--secondary ax-history__retry" data-part="version-try-again" onClick={onRetry}>{copy["history.versionTryAgain"]}</button>
      </>}
      {selection.state === "ready" && (lines.length === 0
        ? <p className="ax-history__note" data-part="no-text">{copy["history.noText"]}</p>
        : lines.map((line, index) => <p key={index} className="ax-history__line" data-part="preview-line">{line}</p>))}
    </div>
  );
}

function VersionEntry({ item, timeZone, inBook, selection, onOpen, onRetry }: {
  item: HistoryItem;
  timeZone?: string;
  inBook: boolean;
  selection: Selection | null;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const date = formatVersionDate(item.at, timeZone);
  const source = sourceWord(item.source);
  const words = wordsLabel(item.word_count);
  const mark = inBook ? copy["history.inBook"] : "";
  const label = [date, source, words, mark].filter(Boolean).join(", ");
  return (
    <li className="ax-history__version" data-part="version">
      <button ref={button} type="button" className="ax-history__open" data-part="version-open" aria-expanded={selection !== null}
        aria-label={label} onClick={(event) => {
          event.currentTarget.focus();
          onOpen(item.id);
        }}>
        <span className="ax-history__date" data-part="version-date">{date}</span>
        <span className="ax-history__source" data-part="version-source">{source}</span>
        <span className="ax-history__words" data-part="version-words">{words}</span>
        {inBook && <span className="ax-history__in-book" data-part="in-book">{mark}</span>}
        {selection !== null && <span className="ax-history__underline" data-part="version-underline" aria-hidden="true" />}
      </button>
      {selection !== null && <VersionDetail selection={selection} onRetry={() => {
        button.current?.focus();
        onRetry(item.id);
      }} />}
    </li>
  );
}

export function History({ chapterId, refreshToken = 0, timeZone }: Props) {
  const initialChapter = useRef(chapterId).current;
  const root = useRef<HTMLElement>(null);
  const [list, setList] = useState<List>({ state: "loading" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const latestHistoryRead = useRef(0);
  const versionGeneration = useRef(0);
  const cache = useRef(new Map<string, VersionText>());
  const pending = useRef(new Set<string>());

  const readHistory = useCallback(async () => {
    const read = ++latestHistoryRead.current;
    setList((previous) => previous.state === "ready"
      ? { ...previous, refreshFailed: false }
      : { state: "loading" });
    try {
      const history = await getHistory(initialChapter);
      if (read !== latestHistoryRead.current) return;
      setList({ state: "ready", history, refreshFailed: false });
      setSelection((previous) => previous && history.versions.some(({ id }) => id === previous.id) ? previous : null);
    } catch {
      if (read !== latestHistoryRead.current) return;
      setList((previous) => previous.state === "ready"
        ? { ...previous, refreshFailed: true }
        : { state: "failed" });
    }
  }, [initialChapter]);

  useEffect(() => () => {
    latestHistoryRead.current++;
    versionGeneration.current++;
    cache.current.clear();
    pending.current.clear();
  }, []);

  useEffect(() => { void readHistory(); }, [readHistory, refreshToken]);

  async function readVersion(id: string) {
    setSelection({ id, state: "loading" });
    if (pending.current.has(id)) return;
    pending.current.add(id);
    const generation = versionGeneration.current;
    try {
      const text = await getVersion(initialChapter, id);
      if (generation !== versionGeneration.current) return;
      cache.current.set(id, text);
      setSelection((previous) => previous?.id === id ? { id, state: "ready", text } : previous);
    } catch {
      if (generation !== versionGeneration.current) return;
      setSelection((previous) => previous?.id === id ? { id, state: "failed" } : previous);
    } finally {
      if (generation === versionGeneration.current) pending.current.delete(id);
    }
  }

  function toggleVersion(id: string) {
    if (selection?.id === id) {
      setSelection(null);
      return;
    }
    const text = cache.current.get(id);
    if (text) setSelection({ id, state: "ready", text });
    else void readVersion(id);
  }

  function retryHistory() {
    root.current?.focus();
    void readHistory();
  }

  return (
    <section ref={root} className="ax-history" data-surface="history" data-state={list.state} tabIndex={-1}>
      {list.state === "loading" && <p className="ax-history__reading" data-part="reading" role="status">{copy["history.reading"]}<span className="ax-reading-rule" data-part="reading-rule" aria-hidden="true" /></p>}
      {list.state === "failed" && <>
        <p className="ax-history__note" data-part="read-failure" role="status">{copy["history.readFailed"]}</p>
        <button type="button" className="ax-button ax-button--secondary ax-history__retry" data-part="try-again" onClick={retryHistory}>{copy["history.tryAgain"]}</button>
      </>}
      {list.state === "ready" && <>
        {list.refreshFailed && <>
          <p className="ax-history__note" data-part="refresh-failure" role="status">{copy["history.refreshFailed"]}</p>
          <button type="button" className="ax-button ax-button--secondary ax-history__retry" data-part="refresh-again" onClick={retryHistory}>{copy["history.refreshAgain"]}</button>
        </>}
        {list.history.versions.length === 0
          ? <p className="ax-history__empty" data-part="empty">{copy["history.empty"]}</p>
          : <ul className="ax-history__list" data-part="version-list">
            {list.history.versions.map((item) => <VersionEntry key={item.id} item={item}
              timeZone={timeZone} inBook={item.id === list.history.active_version_id}
              selection={selection?.id === item.id ? selection : null}
              onOpen={toggleVersion} onRetry={(id) => { void readVersion(id); }} />)}
          </ul>}
      </>}
    </section>
  );
}
