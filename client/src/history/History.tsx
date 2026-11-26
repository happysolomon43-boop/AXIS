import "./history.css";
import "./restore.css";
import "./snapshots.css";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { getHistory, getVersion, restoreVersion, nameSnapshot, validNamedSnapshot } from "../api/endpoints";
import type { ChapterHistory, HistoryItem, NamedSnapshot, VersionText } from "../api/types";
import { ApiError } from "../api/http";
import { copy } from "../copy";
import { formatVersionDate, previewBlocks, sourceWord, wordsLabel } from "./historyFormat";

export type RestoreOutcome = { version_id: string; checkpoint_version_id: string | null };
export type OnRestored = (outcome: RestoreOutcome) => "applied" | "kept";

type Props = {
  chapterId: string; seriesId?: string; refreshToken?: number; timeZone?: string; locked?: boolean; onRestored?: OnRestored;
};
type List = { state: "loading" | "failed" } | { state: "ready"; history: ChapterHistory; refreshFailed: boolean };
type Selection = { id: string; state: "loading" | "failed" } | { id: string; state: "ready"; text: VersionText };
type RestoreOperation =
  | { state: "restoring"; id: string }
  | { state: "settling"; knownIds: Set<string>; textHash: string; notify: OnRestored };
type RestoreResult = { part: "restore-status" | "restore-failure"; message: string };

type Naming = {
  chapter: string; id: string; number: number; cut: number; value: string;
  phase: "editing" | "pending" | "settled"; failure?: string; invalid?: boolean;
  noRetry?: boolean; confirmed?: NamedSnapshot;
};
function namingFailure(error: unknown): { failure: string; invalid?: boolean; noRetry?: boolean } {
  if (error instanceof ApiError) {
    const details = error.details as { reason?: unknown; errors?: unknown } | null;
    if (error.status === 400 && error.code === "validation_failed" && Array.isArray(details?.errors)) {
      if (details.errors.some(e => e?.path === "/name")) return { failure: copy["history.snapshot.invalid"], invalid: true };
      if (details.errors.some(e => e?.path === "/version_id" && e?.message === "nothing to capture")) return { failure: copy["history.snapshot.emptyVersion"] };
    }
    if (error.status === 409 && error.code === "snapshot_conflict") {
      if (details?.reason === "name_exists") return { failure: copy["history.snapshot.conflict"], noRetry: true };
      if (details?.reason === "released_book") return { failure: copy["history.snapshot.released"], noRetry: true };
      return { failure: copy["history.snapshot.failed"], noRetry: true };
    }
  }
  return { failure: copy["history.snapshot.failed"] };
}
function savedSnapshot(item: HistoryItem): NamedSnapshot | null {
  return validNamedSnapshot(item.snapshot, item.chapter_id, item.id) && item.snapshot.l_seq === item.l_seq ? item.snapshot : null;
}
function carryNames(previous: List, history: ChapterHistory): ChapterHistory {
  if (previous.state !== "ready") return history;
  return { ...history, versions: history.versions.map(item => {
    const old = previous.history.versions.find(row => row.id === item.id && row.l_seq === item.l_seq);
    const snapshot = old && savedSnapshot(old);
    return !item.snapshot && snapshot ? { ...item, snapshot, can_name_snapshot: false } : item;
  }) };
}
function SnapshotCapture({ item }: { item: HistoryItem }) {
  const snapshot = savedSnapshot(item);
  return snapshot && <>
    <p className="ax-history__snapshot-cut" data-part="snapshot-cut">{copy["history.snapshot.cut"](item.version_no, snapshot.l_seq)}</p>
    <div className="ax-history__snapshot-capture" data-part="snapshot-capture">
      <p>{copy["history.snapshot.captured"]}</p><p>{copy["history.snapshot.coverage"]}</p><p>{copy["history.snapshot.excluded"]}</p>
    </div>
  </>;
}
const keepDraft: OnRestored = () => "kept";

function restoreStatus(disposition: ReturnType<OnRestored>, checkpointId: string | null): RestoreResult {
  const sentence = copy[disposition === "applied" ? "history.restored" : "history.restoredKept"];
  const note = checkpointId === null ? "" : ` ${copy["history.checkpointNote"]}`;
  return { part: "restore-status", message: sentence + note };
}

function VersionDetail({ selection, onRetry, actions, item }: { selection: Selection; onRetry: () => void; actions?: ReactNode; item: HistoryItem }) {
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
      <SnapshotCapture item={item} />
      {selection.state === "ready" && actions}
    </div>
  );
}

function VersionEntry({ item, timeZone, inBook, selection, onOpen, onRetry, actions, namingAction }: {
  item: HistoryItem;
  timeZone?: string;
  inBook: boolean;
  selection: Selection | null;
  onOpen: (id: string) => void;
  onRetry: (id: string) => void;
  actions?: ReactNode;
  namingAction?: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const date = formatVersionDate(item.at, timeZone);
  const source = sourceWord(item.source);
  const words = wordsLabel(item.word_count);
  const mark = inBook ? copy["history.inBook"] : "";
  const label = [date, source, words, mark].filter(Boolean).join(", ");
  return (
    <li className="ax-history__version" data-part="version" data-version-id={item.id}>
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
      {savedSnapshot(item) && <div className="ax-history__snapshot-name" data-part="snapshot-name">
        <span className="ax-history__snapshot-key" aria-hidden="true">S</span>
        <div><p className="ax-history__snapshot-source">{copy["history.snapshot.namedSource"]}</p>
          <bdi className="ax-history__snapshot-label">{savedSnapshot(item)!.name}</bdi></div>
      </div>}
      {namingAction}
      {selection !== null && <VersionDetail item={item} selection={selection} actions={actions} onRetry={() => {
        button.current?.focus();
        onRetry(item.id);
      }} />}
    </li>
  );
}

export function History({ chapterId, seriesId, refreshToken = 0, timeZone, locked = false, onRestored = keepDraft }: Props) {
  const initialChapter = useRef(chapterId).current;
  const root = useRef<HTMLElement>(null);
  const [list, setList] = useState<List>({ state: "loading" });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [restore, setRestore] = useState<RestoreOperation | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [filter, setFilter] = useState<"named" | "all">("all");
  const [naming, setNaming] = useState<Naming | null>(null);
  const namingRef = useRef<Naming | null>(null);
  const [nameStatus, setNameStatus] = useState("");
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const focusNext = useRef<{ kind: "input" | "cancel" | "opener" | "row"; id?: string } | null>(null);
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  function changeNaming(next: Naming | null) {
    namingRef.current = next;
    setNaming(next);
  }
  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    if (next.kind === "input") input.current?.focus();
    else if (next.kind === "cancel") cancel.current?.focus();
    else if (next.kind === "opener") {
      if (opener.current?.isConnected) opener.current.focus();
      else root.current?.focus();
    } else {
      const row = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-version-id]") ?? [])
        .find(el => el.dataset.versionId === next.id);
      (row?.querySelector<HTMLElement>('[data-part="version-open"]') ?? root.current)?.focus();
    }
  }, [naming]);
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
    setList(previous => ({ state: "ready", history: carryNames(previous, history), refreshFailed: false }));
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

  function eligible(item: HistoryItem) {
    return !!seriesId && item.can_name_snapshot === true && !item.snapshot;
  }

  function openNaming(item: HistoryItem, button: HTMLButtonElement) {
    if (!eligible(item) || namingRef.current?.phase === "pending") return;
    opener.current = button;
    focusNext.current = { kind: "input" };
    setNameStatus("");
    changeNaming({ chapter: initialChapter, id: item.id, number: item.version_no, cut: item.l_seq, value: "", phase: "editing" });
  }
  function closeNaming() {
    if (!namingRef.current || namingRef.current.phase === "pending") return;
    focusNext.current = { kind: "opener" };
    setNameStatus("");
    changeNaming(null);
  }
  function mergeSnapshot(snapshot: NamedSnapshot) {
    setList(previous => previous.state !== "ready" ? previous : {
      ...previous, history: { ...previous.history, versions: previous.history.versions.map(row =>
        row.id === snapshot.version_id && row.chapter_id === snapshot.chapter_id && row.l_seq === snapshot.l_seq
          ? { ...row, snapshot, can_name_snapshot: false } : row) }
    });
  }
  async function submitNaming() {
    const target = namingRef.current;
    if (!seriesId || !target || target.phase !== "editing" || target.noRetry || list.state !== "ready"
      || !list.history.versions.some(row => row.id === target.id && row.l_seq === target.cut && eligible(row))) return;
    const pendingTarget: Naming = { ...target, phase: "pending", failure: undefined, invalid: false };
    changeNaming(pendingTarget);
    setNameStatus(copy["history.snapshot.pending"]);
    const stillLive = () => live.current && namingRef.current === pendingTarget;
    let error: unknown;
    try {
      const saved = await nameSnapshot(seriesId, target.chapter, target.id, target.value === "" ? undefined : target.value);
      if (!stillLive()) return;
      if (saved && saved.l_seq === target.cut) {
        if (form.current?.contains(document.activeElement)) focusNext.current = { kind: "row", id: target.id };
        mergeSnapshot(saved);
        setNameStatus(copy["history.snapshot.success"]);
        changeNaming(null);
        return;
      }
    } catch (e) { error = e; }
    if (!stillLive()) return;
    let snapshot: NamedSnapshot | null = null;
    let confirmedIneligible = false;
    try {
      const settled = await getHistory(target.chapter);
      if (!stillLive()) return;
      const row = settled.versions.find(item => item.id === target.id && item.chapter_id === target.chapter && item.l_seq === target.cut);
      snapshot = row ? savedSnapshot(row) : null;
      confirmedIneligible = !!row && row.can_name_snapshot === false;
    } catch { /* Keep the original write failure. */ }
    if (!stillLive()) return;
    if (snapshot) {
      mergeSnapshot(snapshot);
      if (form.current?.contains(document.activeElement) && document.activeElement !== input.current
        && document.activeElement !== cancel.current) focusNext.current = { kind: "cancel" };
      setNameStatus(copy["history.snapshot.settled"]);
      changeNaming({ ...target, phase: "settled", confirmed: snapshot });
    } else {
      if (form.current?.contains(document.activeElement)) focusNext.current = { kind: "input" };
      setNameStatus("");
      const failure = namingFailure(error);
      changeNaming({ ...target, phase: "editing", ...failure, noRetry: failure.noRetry || confirmedIneligible });
    }
  }
  const busyNaming = naming?.phase === "pending";
  const visible = list.state === "ready" ? list.history.versions.filter(item => filter === "all" || !!savedSnapshot(item)) : [];
  const newest = list.state === "ready" ? list.history.versions[0] : undefined;
  const targetEligible = list.state === "ready" && naming && list.history.versions.some(row =>
    row.id === naming.id && row.l_seq === naming.cut && eligible(row));
  function nameAction(item: HistoryItem) {
    return <button type="button" data-part="snapshot-name-action"
      className="ax-button ax-button--quiet ax-history__snapshot-action"
      aria-label={copy["history.snapshot.actionLabel"](item.version_no)} aria-disabled={busyNaming || undefined}
      onClick={event => openNaming(item, event.currentTarget)}><span>{copy["history.snapshot.action"]}</span></button>;
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
        <div role="group" aria-label={copy["history.snapshot.filter"]} data-part="snapshot-filter" className="ax-history__snapshot-filter">
          {(["named", "all"] as const).map(value => <button key={value} type="button" data-part={value === "named" ? "snapshot-named" : "snapshot-all"}
            className="ax-history__snapshot-filter-button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {copy[value === "named" ? "history.snapshot.named" : "history.snapshot.all"]}
            {filter === value && <span className="ax-history__snapshot-underline" aria-hidden="true" />}
          </button>)}
        </div>
        {naming && <form ref={form} className="ax-history__snapshot-form" data-part="snapshot-name-form"
          onSubmit={event => { event.preventDefault(); void submitNaming(); }}>
          <p className="ax-history__snapshot-version">{copy["history.snapshot.version"](naming.number)}</p>
          <div className="ax-field">
            <label className="ax-field-label" htmlFor={formId}>{copy["history.snapshot.label"]}</label>
            <input ref={input} id={formId} type="text" className="ax-input" data-part="snapshot-name-input"
              aria-describedby={formId + "-hint" + (naming.invalid ? " " + formId + "-failure" : "")}
              aria-invalid={naming.invalid || undefined} readOnly={naming.phase !== "editing"} value={naming.value}
              onChange={event => {
                if (namingRef.current?.phase !== "editing") return;
                changeNaming({ ...namingRef.current, value: event.target.value,
                  ...(namingRef.current.invalid ? { invalid: false, failure: undefined } : {}) });
              }} />
            <p id={formId + "-hint"} className="ax-history__snapshot-hint">{copy["history.snapshot.hint"]}</p>
            {naming.confirmed && <bdi className="ax-history__snapshot-label">{naming.confirmed.name}</bdi>}
          </div>
          {naming.failure && <p id={formId + "-failure"} role="alert" data-part="snapshot-name-failure" className="ax-history__snapshot-failure">
            {naming.invalid && <span className="ax-glyph-square" aria-hidden="true" />}{naming.failure}
          </p>}
          <div className="ax-history__snapshot-form-actions">
            {naming.phase !== "settled" && (busyNaming || (!naming.noRetry && targetEligible)) &&
              <button type="submit" className="ax-button ax-button--secondary" data-part="snapshot-name-submit"
                aria-disabled={busyNaming || undefined}><span>{copy["history.snapshot.action"]}</span></button>}
            <button ref={cancel} type="button" className="ax-button ax-button--quiet" data-part="snapshot-name-cancel"
              aria-disabled={busyNaming || undefined} onClick={closeNaming}><span>{copy["history.snapshot.cancel"]}</span></button>
          </div>
        </form>}
        <p data-part="snapshot-name-status" role="status" className="ax-history__snapshot-status">{nameStatus}</p>
        {visible.length === 0
          ? filter === "named" ? <div className="ax-history__snapshot-empty">
              <p data-part="snapshot-empty">{copy["history.snapshot.empty"]}</p>
              {newest && eligible(newest) && nameAction(newest)}
            </div> : <p className="ax-history__empty" data-part="empty">{copy["history.empty"]}</p>
          : <ul className="ax-history__list" data-part="version-list">
            {visible.map((item) => {
              const index = list.history.versions.findIndex(row => row.id === item.id);
              const selected = selection?.id === item.id ? selection : null;
              const restoring = restore?.state === "restoring" && restore.id === item.id;
              return <VersionEntry key={item.id} item={item}
                timeZone={timeZone} inBook={item.id === list.history.active_version_id}
                selection={selected} namingAction={eligible(item) ? nameAction(item) : undefined} onOpen={toggleVersion} onRetry={(id) => { void readVersion(id); }}
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
