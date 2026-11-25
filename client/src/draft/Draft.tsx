import "./draft.css";
import "./autosave.css";
import "./conflict.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { getChapter, getDraft, putDraft, saveVersion, sendChapter } from "../api/endpoints";
import { ApiError } from "../api/http";
import type { ChapterDetail, DraftHead } from "../api/types";
import { versionChip } from "../binder/format";
import { copy } from "../copy";
import { Editor } from "../editor/Editor";
import { blocksFromServed, blocksToDoc, docToBlocks, serializeBlocks, type EditorBlock } from "../editor/model";
import { fireAt } from "./autosave";

type Props = {
  chapterId: string;
  onLockChange: (locked: boolean) => void;
  onWritten: () => void;
  onEditorReady?: (view: EditorView) => void;
};
type Write = { kind: "save" | "send"; content: string; parent: string; doc: Node };
type Phase = "saving" | "sending" | "checking" | "write-failed" | "check-failed" | "reloading";
type Ready = {
  state: "ready";
  blocks: EditorBlock[];
  baselineDoc: Node;
  doc: Node;
  loadedVersionId: string;
  activeVersionId: string | null;
  phase: Phase | null;
  write: Write | null;
  outcome: "saved" | "sent" | null;
  headRevision: number;
  persistedDoc: Node | null;
  autosaveInFlight: boolean;
  stopped: boolean;
  reloadFailed: boolean;
  editorKey: number;
  lastChangeAt: number;
  dirtySince: number;
  lastPutStartAt: number | null;
  failedAt: number | null;
};
type Snapshot = { state: "loading" } | { state: "failed" } | Ready;

function dirty(s: Ready) { return !s.doc.eq(s.baselineDoc); }
function kept(s: Ready) { return s.persistedDoc !== null && s.doc.eq(s.persistedDoc); }
function due(s: Ready) { return s.persistedDoc === null ? dirty(s) : !kept(s); }
function locked(s: Snapshot) {
  return s.state === "ready" && (s.phase !== null || (dirty(s) && !kept(s)));
}
function busy(s: Ready) {
  return s.phase === "saving" || s.phase === "sending" || s.phase === "checking" || s.phase === "reloading";
}
function keepMineActive(s: Ready) { return s.stopped && !busy(s) && dirty(s); }
function active(s: Ready, kind: Write["kind"]) {
  return !busy(s) && s.phase !== "check-failed" && (dirty(s) || (kind === "send" && s.activeVersionId !== s.loadedVersionId));
}

function autosaveStatus(s: Ready) {
  if (s.stopped) return "stopped";
  if (s.autosaveInFlight) return "saving";
  if (due(s)) return s.failedAt === null ? "pending" : "failed";
  return dirty(s) && kept(s) ? "saved" : "idle";
}

function fromRead(detail: ChapterDetail, draft: DraftHead | null): Ready {
  if (detail.version === null || (draft !== null && draft.base_version !== detail.version.id)) {
    throw new Error("Draft and chapter versions do not match");
  }
  const served = blocksFromServed(detail.blocks);
  const blocks = draft === null ? served : draft.blocks.map(({ kind, text }) => ({ kind, text }));
  const baselineDoc = blocksToDoc(served);
  const doc = draft === null ? baselineDoc : blocksToDoc(blocks);
  return {
    state: "ready", blocks, baselineDoc, doc, loadedVersionId: detail.version.id,
    activeVersionId: detail.active_version_id, phase: null, write: null, outcome: null,
    headRevision: draft?.revision ?? 0, persistedDoc: draft === null ? null : doc,
    autosaveInFlight: false, stopped: false, reloadFailed: false, editorKey: 0,
    lastChangeAt: 0, dirtySince: 0,
    lastPutStartAt: null, failedAt: null,
  };
}

export function Draft({ chapterId, onLockChange, onWritten, onEditorReady }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: "loading" });
  const current = useRef(snapshot);
  const callbacks = useRef({ onLockChange, onWritten, onEditorReady });
  callbacks.current = { onLockChange, onWritten, onEditorReady };
  const generation = useRef(0);
  const mounted = useRef(false);
  const editor = useRef<EditorView | null>(null);
  const refocus = useRef(false);
  const pendingAutosave = useRef<Promise<void> | null>(null);

  const update = useCallback((next: Snapshot) => {
    if (!mounted.current) return;
    const oldLock = locked(current.current);
    current.current = next;
    setSnapshot(next);
    const newLock = locked(next);
    if (oldLock !== newLock) callbacks.current.onLockChange(newLock);
  }, []);

  const isCurrent = useCallback((number: number) => mounted.current && number === generation.current, []);

  const read = useCallback(async () => {
    const number = ++generation.current;
    update({ state: "loading" });
    try {
      const detail = await getChapter(chapterId);
      if (!isCurrent(number)) return;
      if (detail.version === null) {
        update({ state: "failed" });
        return;
      }
      const { draft } = await getDraft(chapterId);
      if (isCurrent(number)) update(fromRead(detail, draft));
    } catch {
      if (isCurrent(number)) update({ state: "failed" });
    }
  }, [chapterId, isCurrent, update]);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
      generation.current++;
      pendingAutosave.current = null;
      editor.current = null;
      refocus.current = false;
    };
  }, [read]);

  useEffect(() => {
    if (snapshot.state !== "ready" || !due(snapshot) || snapshot.stopped || busy(snapshot) || snapshot.autosaveInFlight) {
      return;
    }

    const number = generation.current;
    const timer = window.setTimeout(() => {
      if (!isCurrent(number) || current.current !== snapshot) return;
      const docSent = snapshot.doc;
      const content = serializeBlocks(docToBlocks(docSent));
      const baseVersion = snapshot.loadedVersionId;
      const baseRevision = snapshot.headRevision;
      update({ ...snapshot, autosaveInFlight: true, lastPutStartAt: Date.now() });

      pendingAutosave.current = saveDraft();
      async function saveDraft() {
        let revision: number | null = null;
        let stopped = false;
        try {
          const result = await putDraft(chapterId, content, baseVersion, baseRevision);
          revision = result.revision;
        } catch (error) {
          if (!isCurrent(number)) return;
          if (error instanceof ApiError && error.code === "conflict") {
            try {
              const { draft } = await getDraft(chapterId);
              if (draft !== null && draft.content === content && draft.base_version === baseVersion) {
                revision = draft.revision;
              }
            } catch {
              // A failed adoption read leaves the conflict unresolved.
            }
            stopped = revision === null;
          }
        }

        const s = current.current;
        if (!isCurrent(number) || s.state !== "ready") return;
        pendingAutosave.current = null;
        const now = Date.now();
        const settled = { ...s, autosaveInFlight: false };
        // Check again may have found a landed write while this request was in flight.
        if (s.loadedVersionId !== baseVersion) {
          update(settled);
          return;
        }
        if (revision !== null) {
          const saved = { ...settled, headRevision: revision, persistedDoc: docSent, failedAt: null };
          update(due(saved) ? { ...saved, dirtySince: now } : saved);
        } else if (stopped) {
          update({ ...settled, stopped: true, persistedDoc: null });
        } else {
          update({ ...settled, failedAt: now });
        }
      }
    }, Math.max(0, fireAt(snapshot) - Date.now()));

    return () => window.clearTimeout(timer);
  }, [chapterId, isCurrent, snapshot, update]);

  function beginBusy(s: Ready, phase: Phase, write: Write | null) {
    if (editor.current) {
      refocus.current = editor.current.hasFocus();
      editor.current.setProps({ editable: () => false });
    }
    update({ ...s, phase, write, outcome: null });
  }

  function finishBusy() {
    const view = editor.current;
    if (view) {
      view.setProps({ editable: () => true });
      if (refocus.current) view.focus();
    }
    refocus.current = false;
  }

  function settle(number: number, write: Write, loadedVersionId: string, activeVersionId: string | null) {
    if (!mounted.current || number !== generation.current || current.current.state !== "ready") return;
    update({
      ...current.current, loadedVersionId, activeVersionId, baselineDoc: write.doc, phase: null,
      write: null, outcome: write.kind === "save" ? "saved" : "sent",
      headRevision: 0, persistedDoc: null, stopped: false, reloadFailed: false, failedAt: null, lastPutStartAt: null,
    });
    finishBusy();
    if (mounted.current && number === generation.current) callbacks.current.onWritten();
  }

  async function check(number: number, write: Write) {
    if (!mounted.current || number !== generation.current || current.current.state !== "ready") return;
    update({ ...current.current, phase: "checking", write });
    try {
      const detail = await getChapter(chapterId);
      if (!mounted.current || number !== generation.current || current.current.state !== "ready") return;
      const version = detail.version;
      if (version !== null && version.id !== write.parent && version.content === write.content
          && (write.kind === "save" || detail.active_version_id === version.id)) {
        settle(number, write, version.id, detail.active_version_id);
      } else {
        update({ ...current.current, phase: "write-failed" });
        finishBusy();
      }
    } catch {
      if (mounted.current && number === generation.current && current.current.state === "ready") {
        update({ ...current.current, phase: "check-failed" });
        finishBusy();
      }
    }
  }

  async function start(kind: Write["kind"], keepMine = false) {
    const s = current.current;
    if (!mounted.current || s.state !== "ready") return;
    if (!(keepMine ? keepMineActive(s) : active(s, kind))) return;
    const write: Write = { kind, doc: s.doc, content: serializeBlocks(docToBlocks(s.doc)), parent: s.loadedVersionId };
    const number = generation.current;
    beginBusy(s, kind === "save" ? "saving" : "sending", write);
    if (pendingAutosave.current !== null) {
      await pendingAutosave.current;
      if (!isCurrent(number)) return;
    }
    let response;
    try {
      response = await (kind === "save" ? saveVersion : sendChapter)(chapterId, write.content, write.parent);
    } catch {
      await check(number, write);
      return;
    }
    settle(number, write, response.version.id, response.active_version_id);
  }

  function checkAgain() {
    const s = current.current;
    if (s.state !== "ready" || s.phase !== "check-failed" || s.write === null) return;
    const number = generation.current;
    beginBusy(s, "checking", s.write);
    void check(number, s.write);
  }

  async function reloadLatest() {
    const s = current.current;
    if (!mounted.current || s.state !== "ready" || !s.stopped || busy(s)) return;
    const number = ++generation.current;
    beginBusy({ ...s, reloadFailed: false }, "reloading", s.write);
    try {
      const detail = await getChapter(chapterId);
      if (!isCurrent(number)) return;
      const { draft } = await getDraft(chapterId);
      if (!isCurrent(number)) return;
      const next = fromRead(detail, draft);
      refocus.current = false;
      update({ ...next, editorKey: number });
    } catch {
      if (!isCurrent(number)) return;
      update({ ...s, reloadFailed: true });
      finishBusy();
    }
  }

  function docChange(doc: Node) {
    const s = current.current;
    if (s.state !== "ready" || busy(s)) return;
    const now = Date.now();
    const next = { ...s, doc, lastChangeAt: now, outcome: null };
    update(!due(s) && due(next) ? { ...next, dirtySince: now } : next);
  }

  async function copyChapter() {
    const s = current.current;
    if (s.state !== "ready") return;
    try { await navigator.clipboard.writeText(serializeBlocks(docToBlocks(s.doc))); } catch { /* clipboard unavailable */ }
  }

  const isReady = snapshot.state === "ready";
  const isLocked = locked(snapshot);
  const isBusy = isReady && busy(snapshot);

  const actions = useRef({ start });
  actions.current = { start };
  useEffect(() => {
    if (!isReady) return;
    function chord(event: KeyboardEvent) {
      if (event.ctrlKey === event.metaKey || event.altKey) return;
      if (event.code === "KeyS" && !event.shiftKey) {
        event.preventDefault(); void actions.current.start("save");
      } else if (event.code === "Enter" && event.shiftKey) {
        event.preventDefault(); void actions.current.start("send");
      }
    }
    window.addEventListener("keydown", chord);
    return () => window.removeEventListener("keydown", chord);
  }, [isReady]);

  useEffect(() => {
    if (!isLocked) return;
    function guard(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ""; }
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [isLocked]);

  if (snapshot.state === "loading") return (
    <section className="ax-draft" data-surface="draft" data-state="loading" data-autosave="idle">
      <p className="ax-status" role="status" data-part="reading">{copy["draft.opening"]}</p>
      <span className="ax-reading-rule" aria-hidden="true" />
    </section>
  );
  if (snapshot.state === "failed") return (
    <section className="ax-draft" data-surface="draft" data-state="failed" data-autosave="idle">
      <div role="alert" data-part="read-failure">
        <div>{copy["draft.openFailed"]}</div>
        <button type="button" className="ax-button ax-button--secondary" data-part="try-again"
          onClick={() => { if (current.current.state === "failed") void read(); }}>{copy["draft.tryAgain"]}</button>
      </div>
    </section>
  );

  const s = snapshot;
  const state = s.phase ?? (s.stopped ? "conflict" : dirty(s) ? "unsaved" : "clean");
  const showConflict = s.stopped && (!isBusy || s.phase === "reloading");
  const autosave = autosaveStatus(s);
  const saveActive = active(s, "save");
  const sendActive = active(s, "send");
  const chip = versionChip({ version_id: s.loadedVersionId, active_version_id: s.activeVersionId });
  const failure = s.phase === "write-failed" || s.phase === "check-failed";
  const outcome = state === "clean" ? s.outcome : null;
  const status = state === "unsaved" && isLocked ? copy["draft.unsaved"] : state === "saving" ? copy["draft.saving"]
    : state === "sending" ? copy["draft.sending"] : state === "checking" ? copy["draft.checking"]
    : state === "reloading" ? copy["draft.reloading"] : outcome === "saved" ? copy["draft.saved"] : outcome === "sent" ? copy["draft.sent"] : "";
  return (
    <section className="ax-draft" data-surface="draft" data-state={state} data-autosave={autosave}>
      <div className="ax-draft-head" data-part="draft-head">
        <div className="ax-toolbar" data-part="toolbar" role="group">
          {chip !== null && <span data-part="version-chip">{chip}</span>}
          <span className="ax-autosave" data-part="autosave" role="status">
            {autosave !== "idle" && autosave !== "saved" &&
              <span className="ax-autosave__dot" data-part="autosave-dot" aria-hidden="true" />}
            {autosave === "failed" ? copy["draft.autosaveFailed"] : null}
          </span>
          <button type="button" className="ax-button ax-button--secondary" data-part="save" aria-disabled={!saveActive}
            onClick={() => { void start("save"); }}>{copy["draft.save"]}</button>
          <button type="button" className={`ax-button ax-button--${sendActive ? "primary" : "secondary"}`} data-part="send"
            aria-disabled={!sendActive} onClick={() => { void start("send"); }}>{copy["draft.send"]}</button>
        </div>
        <p className="ax-draft-status" role="status" data-part="status" data-outcome={outcome ?? undefined}>{status}</p>
        {showConflict && <div className="ax-banner" role="alert" data-part="conflict">
          <p className="ax-banner__lead">{copy["draft.conflict"]}</p>
          <button type="button" className="ax-button ax-button--secondary" data-part="reload-latest" aria-disabled={isBusy}
            onClick={() => { void reloadLatest(); }}>{copy["draft.reloadLatest"]}</button>
          <button type="button" className="ax-button ax-button--secondary" data-part="keep-mine" aria-disabled={!keepMineActive(s)}
            onClick={() => { void start("save", true); }}>{copy["draft.keepMine"]}</button>
          <button type="button" className="ax-button ax-button--secondary" data-part="conflict-copy"
            onClick={() => { void copyChapter(); }}>{copy["draft.copyChapter"]}</button>
          {s.reloadFailed && <p className="ax-banner__note" role="alert" data-part="reload-failure">{copy["draft.reloadFailed"]}</p>}
        </div>}
        {failure && <div className="ax-banner" role="alert" data-part="write-failure">
          <span className="ax-banner__mark" data-part="not-saved-mark">{copy["draft.notSaved"]}</span>
          <p>{s.write?.kind === "save" ? copy["draft.saveFailed"] : copy["draft.sendFailed"]}</p>
          {!kept(s) && <p data-part="only-here">{copy["draft.onlyHere"]}</p>}
          <button type="button" className="ax-button ax-button--secondary" data-part="copy-chapter"
            onClick={() => { void copyChapter(); }}>{copy["draft.copyChapter"]}</button>
          {s.phase === "check-failed" && <button type="button" className="ax-button ax-button--secondary" data-part="check-again"
            onClick={checkAgain}>{copy["draft.checkAgain"]}</button>}
        </div>}
      </div>
      <div className="ax-draft-page" data-part="page">
        <Editor key={s.editorKey} blocks={s.blocks} editable={!isBusy} onDocChange={docChange} onReady={(view) => {
          editor.current = view;
          view.focus();
          callbacks.current.onEditorReady?.(view);
        }} />
      </div>
    </section>
  );
}
