import "./draft.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { getChapter, saveVersion, sendChapter } from "../api/endpoints";
import { versionChip } from "../binder/format";
import { copy } from "../copy";
import { Editor } from "../editor/Editor";
import { blocksFromServed, blocksToDoc, docToBlocks, serializeBlocks, type EditorBlock } from "../editor/model";

type Props = {
  chapterId: string;
  onLockChange: (locked: boolean) => void;
  onWritten: () => void;
  onEditorReady?: (view: EditorView) => void;
};
type Write = { kind: "save" | "send"; content: string; parent: string; doc: Node };
type Phase = "saving" | "sending" | "checking" | "write-failed" | "check-failed";
type Ready = {
  state: "ready";
  blocks: EditorBlock[];
  baseline: Node;
  doc: Node;
  loadedVersionId: string;
  activeVersionId: string | null;
  phase: Phase | null;
  write: Write | null;
  outcome: "saved" | "sent" | null;
};
type Snapshot = { state: "loading" } | { state: "failed" } | Ready;

function dirty(s: Ready) { return !s.doc.eq(s.baseline); }
function locked(s: Snapshot) { return s.state === "ready" && (dirty(s) || s.phase !== null); }
function busy(s: Ready) { return s.phase === "saving" || s.phase === "sending" || s.phase === "checking"; }
function active(s: Ready, kind: Write["kind"]) {
  return !busy(s) && s.phase !== "check-failed" && (dirty(s) || (kind === "send" && s.activeVersionId !== s.loadedVersionId));
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

  const update = useCallback((next: Snapshot) => {
    if (!mounted.current) return;
    const oldLock = locked(current.current);
    current.current = next;
    setSnapshot(next);
    const newLock = locked(next);
    if (oldLock !== newLock) callbacks.current.onLockChange(newLock);
  }, []);

  const read = useCallback(async () => {
    const number = ++generation.current;
    update({ state: "loading" });
    try {
      const detail = await getChapter(chapterId);
      if (!mounted.current || number !== generation.current) return;
      if (detail.version === null) { update({ state: "failed" }); return; }
      const blocks = blocksFromServed(detail.blocks);
      const doc = blocksToDoc(blocks);
      update({ state: "ready", blocks, doc, baseline: doc, loadedVersionId: detail.version.id,
        activeVersionId: detail.active_version_id, phase: null, write: null, outcome: null });
    } catch {
      if (mounted.current && number === generation.current) update({ state: "failed" });
    }
  }, [chapterId, update]);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => { mounted.current = false; generation.current++; editor.current = null; refocus.current = false; };
  }, [read]);

  function beginBusy(s: Ready, phase: Phase, write: Write) {
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
    update({ ...current.current, loadedVersionId, activeVersionId, baseline: write.doc, phase: null,
      write: null, outcome: write.kind === "save" ? "saved" : "sent" });
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

  async function start(kind: Write["kind"]) {
    const s = current.current;
    if (!mounted.current || s.state !== "ready" || !active(s, kind)) return;
    const write: Write = { kind, doc: s.doc, content: serializeBlocks(docToBlocks(s.doc)), parent: s.loadedVersionId };
    const number = ++generation.current;
    beginBusy(s, kind === "save" ? "saving" : "sending", write);
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
    const number = ++generation.current;
    beginBusy(s, "checking", s.write);
    void check(number, s.write);
  }

  function docChange(doc: Node) {
    const s = current.current;
    if (s.state === "ready" && !busy(s)) update({ ...s, doc, outcome: null });
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
    <section className="ax-draft" data-surface="draft" data-state="loading">
      <p className="ax-status" role="status" data-part="reading">{copy["draft.opening"]}</p>
      <span className="ax-reading-rule" aria-hidden="true" />
    </section>
  );
  if (snapshot.state === "failed") return (
    <section className="ax-draft" data-surface="draft" data-state="failed">
      <div role="alert" data-part="read-failure">
        <div>{copy["draft.openFailed"]}</div>
        <button type="button" className="ax-button ax-button--secondary" data-part="try-again"
          onClick={() => { if (current.current.state === "failed") void read(); }}>{copy["draft.tryAgain"]}</button>
      </div>
    </section>
  );

  const s = snapshot;
  const state = s.phase ?? (dirty(s) ? "unsaved" : "clean");
  const saveActive = active(s, "save");
  const sendActive = active(s, "send");
  const chip = versionChip({ version_id: s.loadedVersionId, active_version_id: s.activeVersionId });
  const failure = s.phase === "write-failed" || s.phase === "check-failed";
  const outcome = state === "clean" ? s.outcome : null;
  const status = state === "unsaved" ? copy["draft.unsaved"] : state === "saving" ? copy["draft.saving"]
    : state === "sending" ? copy["draft.sending"] : state === "checking" ? copy["draft.checking"]
    : outcome === "saved" ? copy["draft.saved"] : outcome === "sent" ? copy["draft.sent"] : "";
  return (
    <section className="ax-draft" data-surface="draft" data-state={state}>
      <div className="ax-draft-head" data-part="draft-head">
        <div className="ax-toolbar" data-part="toolbar" role="group">
          {chip !== null && <span data-part="version-chip">{chip}</span>}
          <button type="button" className="ax-button ax-button--secondary" data-part="save" aria-disabled={!saveActive}
            onClick={() => { void start("save"); }}>{copy["draft.save"]}</button>
          <button type="button" className={`ax-button ax-button--${sendActive ? "primary" : "secondary"}`} data-part="send"
            aria-disabled={!sendActive} onClick={() => { void start("send"); }}>{copy["draft.send"]}</button>
        </div>
        <p className="ax-draft-status" role="status" data-part="status" data-outcome={outcome ?? undefined}>{status}</p>
        {failure && <div className="ax-banner" role="alert" data-part="write-failure">
          <span className="ax-banner__mark" data-part="not-saved-mark">{copy["draft.notSaved"]}</span>
          <p>{s.write?.kind === "save" ? copy["draft.saveFailed"] : copy["draft.sendFailed"]}</p>
          <p data-part="only-here">{copy["draft.onlyHere"]}</p>
          <button type="button" className="ax-button ax-button--secondary" data-part="copy-chapter"
            onClick={() => { void copyChapter(); }}>{copy["draft.copyChapter"]}</button>
          {s.phase === "check-failed" && <button type="button" className="ax-button ax-button--secondary" data-part="check-again"
            onClick={checkAgain}>{copy["draft.checkAgain"]}</button>}
        </div>}
      </div>
      <div className="ax-draft-page" data-part="page">
        <Editor blocks={s.blocks} editable={!isBusy} onDocChange={docChange} onReady={(view) => {
          editor.current = view;
          view.focus();
          callbacks.current.onEditorReady?.(view);
        }} />
      </div>
    </section>
  );
}
