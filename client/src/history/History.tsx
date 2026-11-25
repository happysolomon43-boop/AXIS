import "./history.css";
import "./restore.css";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { getHistory, getVersion, restoreVersion } from "../api/endpoints";
import type { ChapterHistory, HistoryItem, VersionText } from "../api/types";
import { copy } from "../copy";
import { formatVersionDate, previewBlocks, sourceWord, wordsLabel } from "./historyFormat";

export type RestoreOutcome = { version_id: string; checkpoint_version_id: string | null };
export type OnRestored = (outcome: RestoreOutcome) => "applied" | "kept";

type Props = {
  chapterId: string; refreshToken?: number; timeZone?: string; locked?: boolean; onRestored?: OnRestored;
};
type List = { state: "loading" | "failed" } | { state: "ready"; history: ChapterHistory; refreshFailed: boolean };
type Selection = { id: string; state: "loading" | "failed" } | { id: string; state: "ready"; text: VersionText };
type RestoreOperation =
  | { state: "restoring"; id: string }
  | { state: "settling"; knownIds: Set<string>; textHash: string; notify: OnRestored };
type RestoreResult = { part: "restore-status" | "restore-failure"; message: string };

const keepDraft: OnRestored = () => "kept";

function restoreStatus(disposition: ReturnType<OnRestored>, checkpointId: string | null): RestoreResult {
  const sentence = copy[disposition === "applied" ? "history.restored" : "history.restoredKept"];
  const note = checkpointId === null ? "" : ` ${copy["history.checkpointNote"]}`;
  return { part: "restore-status", message: sentence + note };
}

function VersionDetail({ selection, onRetry, actions }: { selection: Selection; onRetry: () => void; actions?: ReactNode }) {
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
      {selection.state === "ready" && actions}
    </div>
  );
}

function VersionEntry({ item, timeZone, inBook, selection, onOpen, onRetry, actions }: {
  item: HistoryItem;
  timeZone?: string;
  inBook: boolean;
  selection: Selection | null;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  actions?: ReactNode;
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
      {selection !== null && <VersionDetail selection={selection} actions={actions} onRetry={() => {
        button.current?.focus();
        onRetry(item.id);
      }} />}
    </li>
  );
}

export function History({ chapterId, refreshToken = 0, timeZone, locked = false, onRestored = keepDraft }: Props) {
  const initialChapter = useRef(chapterId).current;
  const root = useRef<HTMLElement>(null);
  const [list, setList] = useState<List>({ state: "loading" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [restore, setRestore] = useState<RestoreOperation | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const operation = useRef<RestoreOperation | null>(null);
  const latestHistoryRead = useRef(0);
  const versionGeneration = useRef(0);
  const cache = useRef(new Map<string, VersionText>());
  const pending = useRef(new Set<string>());

  const changeRestore = useCallback((next: RestoreOperation | null) => {
    operation.current = next;
    setRestore(next);
  }, []);

  const readHistory = useCallback(async () => {
    const read = ++latestHistoryRead.current;
    setList((previous) => previous.state === "ready"
      ? { ...previous, refreshFailed: false }
      : { state: "loading" });
    let history: ChapterHistory;
    try {
      history = await getHistory(initialChapter);
    } catch {
      if (read !== latestHistoryRead.current) return;
      setList((previous) => previous.state === "ready"
        ? { ...previous, refreshFailed: true }
        : { state: "failed" });
      return;
    }
    if (read !== latestHistoryRead.current) return;
    setList({ state: "ready", history, refreshFailed: false });
    setSelection((previous) => previous && history.versions.some(({ id }) => id === previous.id) ? previous : null);

    const settling = operation.current;
    if (settling?.state === "settling") {
      changeRestore(null);
      const added = history.versions.filter(({ id }) => !settling.knownIds.has(id));
      const landed = added.find(({ source, text_hash }) => source === "restore" && text_hash === settling.textHash);
      if (landed) {
        const checkpointId = added.find(({ source }) => source === "checkpoint")?.id ?? null;
        const disposition = settling.notify({ version_id: landed.id, checkpoint_version_id: checkpointId });
        setResult(restoreStatus(disposition, checkpointId));
      }
    }
  }, [changeRestore, initialChapter]);

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
    setResult(null);
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

  async function pressRestore(item: HistoryItem) {
    if (locked || operation.current !== null || list.state !== "ready") return;
    const generation = versionGeneration.current;
    const stillMounted = () => root.current !== null && generation === versionGeneration.current;
    const knownIds = new Set(list.history.versions.map(({ id }) => id));
    changeRestore({ state: "restoring", id: item.id });
    setResult(null);

    let written;
    try {
      written = await restoreVersion(initialChapter, item.id);
    } catch {
      if (stillMounted()) {
        changeRestore({ state: "settling", knownIds, textHash: item.text_hash, notify: onRestored });
        setResult({ part: "restore-failure", message: copy["history.restoreFailed"] });
        void readHistory();
      }
      return;
    }
    if (stillMounted()) changeRestore(null);
    const checkpointId = written.checkpoint_version_id;
    const disposition = onRestored({ version_id: written.version.id, checkpoint_version_id: checkpointId });
    if (stillMounted()) setResult(restoreStatus(disposition, checkpointId));
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
        {result && <p className="ax-history__note ax-history__result" data-part={result.part} role="status">{result.message}</p>}
        {list.history.versions.length === 0
          ? <p className="ax-history__empty" data-part="empty">{copy["history.empty"]}</p>
          : <ul className="ax-history__list" data-part="version-list">
            {list.history.versions.map((item, index) => {
              const selected = selection?.id === item.id ? selection : null;
              const restoring = restore?.state === "restoring" && restore.id === item.id;
              return <VersionEntry key={item.id} item={item}
                timeZone={timeZone} inBook={item.id === list.history.active_version_id}
                selection={selected} onOpen={toggleVersion} onRetry={(id) => { void readVersion(id); }}
                actions={index !== 0 && selected?.state === "ready" &&
                  <div className="ax-history__actions" data-part="version-actions" data-state={restoring ? "restoring" : "idle"}>
                    <button type="button" className="ax-button ax-button--quiet ax-history__restore" data-part="version-restore"
                      aria-disabled={locked || restore !== null ? true : undefined}
                      onClick={() => { void pressRestore(item); }}>
                      {copy[restoring ? "history.restoring" : "history.restore"]}
                    </button>
                    {locked && <p className="ax-history__note" data-part="restore-blocked" role="status">{copy["history.restoreBlocked"]}</p>}
                  </div>} />;
            })}
          </ul>}
      </>}
    </section>
  );
}
