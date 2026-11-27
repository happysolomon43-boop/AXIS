import "./draft.css";
import "./autosave.css";
import "./conflict.css";
import "../styles/binder-sync.css";
import "../styles/draft-snapshot.css";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Node } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { captureSnapshot, getSnapshotCapture, getWorkingState, getDraftSync, getWriteReceipt, isDefiniteWriteFailure, putDraft, writeChapter } from "../api/endpoints";
import { ApiError } from "../api/http";
import type { CaptureRequest, CaptureResult, ChapterSync, WorkingState, WriteOperation, WriteRequest, WriteResult } from "../api/types";
import { syncChip } from "../binder/format";
import { copy } from "../copy";
import { Editor } from "../editor/Editor";
import { blocksFromServed, blocksToDoc, docToBlocks, serializeBlocks, type EditorBlock } from "../editor/model";
import { fireAt } from "./autosave";
import { revision as validRevision, versionId } from "../api/validation";

type Props = {
  chapterId: string;
  reloadToken?: number;
  restoredVersionId?: string;
  onDocumentChange?: () => void;
  syncRefreshToken?: number;
  onLockChange: (locked: boolean) => void;
  onWritten: () => void;
  onEditorReady?: (view: EditorView) => void;
};
type Write = { kind: Exclude<WriteOperation, "restore">; doc: Node; request: WriteRequest; book: string };
type Coordinates = Pick<WriteRequest, "base_version" | "base_revision">;
type Phase = "saving" | "sending" | "checking" | "write-failed" | "check-failed" | "reloading";
type Ready = {
  state: "ready";
  blocks: EditorBlock[];
  baselineDoc: Node;
  baselineRaw: string;
  persistedRaw: string | null;
  capturing: boolean;
  doc: Node;
  loadedVersionId: string;
  bookId: string;
  conflictBase: Coordinates | null;
  competingDraft: boolean;
  activeVersionId: string | null;
  sync: ChapterSync | undefined;
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
type CapturePhase = "idle" | "taking" | "checking" | "unknown" | "manual";
type CaptureUI = { form: boolean; name: string; phase: CapturePhase; status: string; failure: string; invalid: boolean; conflict: boolean };
type CaptureAttempt = { number: number; doc: Node; name?: string; body: CaptureRequest | null; end: () => void };
const initialCapture: CaptureUI = { form:false, name:"", phase:"idle", status:"", failure:"", invalid:false, conflict:false };
function captureEligible(s: Snapshot): s is Ready { return s.state === "ready" && s.phase === null && !s.stopped && !s.capturing; }
function detailsObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function hasDetail(error: ApiError, path: string, message?: string) {
  const errors = detailsObject(error.details)?.errors;
  return Array.isArray(errors) && errors.some(item => {
    const e = detailsObject(item); return e?.path === path && (message === undefined || e.message === message);
  });
}

function dirty(s: Ready) { return !s.doc.eq(s.baselineDoc); }
function kept(s: Ready) { return s.persistedDoc !== null && s.doc.eq(s.persistedDoc); }
function due(s: Ready) { return s.persistedDoc === null ? dirty(s) : !kept(s); }
function locked(s: Snapshot) {
  return s.state === "ready" && (s.capturing || s.phase !== null || (dirty(s) && !kept(s)));
}
function busy(s: Ready) {
  return s.capturing || s.phase === "saving" || s.phase === "sending" || s.phase === "checking" || s.phase === "reloading";
}
function conflictBase(error: unknown): Coordinates | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== "conflict") return null;
  const details = detailsObject(error.details);
  if ((details?.reason !== "version" && details?.reason !== "revision") ||
      !versionId(details.current_version) || !validRevision(details.current_revision)) return null;
  return { base_version: details.current_version, base_revision: details.current_revision };
}
function writeBase(result: WriteResult): Coordinates {
  return { base_version: result.current.version_id, base_revision: result.current.revision };
}
function keepMineActive(s: Ready) {
  return s.stopped && (s.phase === null || s.phase === "write-failed") && !s.capturing && !s.competingDraft && dirty(s);
}
function active(s: Ready, kind: Write["kind"]) {
  return !s.stopped && !busy(s) && s.phase !== "check-failed" && (dirty(s) || (kind === "send" && s.activeVersionId !== s.loadedVersionId));
}

function autosaveStatus(s: Ready) {
  if (s.stopped) return "stopped";
  if (s.autosaveInFlight) return "saving";
  if (due(s)) return s.failedAt === null ? "pending" : "failed";
  return dirty(s) && kept(s) ? "saved" : "idle";
}

function fromRead(detail: WorkingState): Ready {
  const { draft, sync } = detail;
  if (detail.version === null) {
    throw new Error("Draft and chapter versions do not match");
  }
  const served = blocksFromServed(detail.blocks);
  const blocks = draft === null ? served : draft.blocks.map(({ kind, text }) => ({ kind, text }));
  const baselineDoc = blocksToDoc(served);
  const doc = draft === null ? baselineDoc : blocksToDoc(blocks);
  return {
    state: "ready", blocks, baselineDoc, doc, loadedVersionId: detail.version.id,
    bookId: detail.chapter.book_id, conflictBase: null, competingDraft: false,
    baselineRaw: detail.version.content, persistedRaw: draft?.content ?? null, capturing: false,
    activeVersionId: detail.active_version_id, sync, phase: null, write: null, outcome: null,
    headRevision: draft?.revision ?? 0, persistedDoc: draft === null ? null : doc,
    autosaveInFlight: false, stopped: false, reloadFailed: false, editorKey: 0,
    lastChangeAt: 0, dirtySince: 0,
    lastPutStartAt: null, failedAt: null,
  };
}

export function Draft({ chapterId, reloadToken = 0, restoredVersionId, syncRefreshToken = 0, onLockChange, onWritten, onEditorReady, onDocumentChange }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ state: "loading" });
  const current = useRef(snapshot);
  const [captureUI, setCaptureUI] = useState<CaptureUI>(initialCapture);
  const captureCurrent = useRef(captureUI);
  const captureAttempt = useRef<CaptureAttempt | null>(null);
  const captureRoot = useRef<HTMLElement | null>(null);
  const snapshotButton = useRef<HTMLButtonElement>(null);
  const snapshotForm = useRef<HTMLFormElement>(null);
  const snapshotName = useRef<HTMLInputElement>(null);
  const snapshotCheck = useRef<HTMLButtonElement>(null);
  const snapshotReturn = useRef<HTMLButtonElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const writeCheckButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const focusRequest = useRef<{ previous: Element | null; target: "input" | "snapshot" | "check" | "reload" | "save" | "send" } | null>(null);
  function changeCapture(next: CaptureUI) {
    captureCurrent.current = next;
    setCaptureUI(next);
  }
  function formFocus(target: "snapshot" | "check" | "reload") {
    const previous = document.activeElement;
    if (snapshotForm.current?.contains(previous) || previous === snapshotCheck.current || previous === snapshotReturn.current ||
      (target === "reload" && previous === snapshotButton.current)) {
      focusRequest.current = { previous, target };
    }
  }
  useLayoutEffect(() => {
    const move = focusRequest.current;
    focusRequest.current = null;
    if (!move || !mounted.current) return;
    if (document.activeElement !== move.previous && document.activeElement !== document.body) return;
    const target = move.target === "input" ? snapshotName.current : move.target === "check" ? snapshotCheck.current :
      move.target === "reload" ? reloadButton.current : move.target === "save" ? saveButton.current :
      move.target === "send" ? sendButton.current : snapshotButton.current ?? reloadButton.current;
    target?.focus();
  });

  // Keep autosave's existing scheduling independent of sync-only changes.
  const ordinarySnapshot = useRef(snapshot);
  const autosaveBasis = ordinarySnapshot.current;
  const ordinary = useRef({ generation: 0, active: 0 });
  const baseGeneration = useRef(0);
  const handledBaseToken = useRef(syncRefreshToken);
  const latestSyncToken = useRef(syncRefreshToken);
  const handledSyncToken = useRef(syncRefreshToken);
  const syncInFlight = useRef<{ token: number; generation: number } | null>(null);
  const [syncWake, setSyncWake] = useState(0);
  const callbacks = useRef({ onLockChange, onWritten, onEditorReady });
  callbacks.current = { onLockChange, onWritten, onEditorReady };
  const generation = useRef(0);
  const mounted = useRef(false);
  const editor = useRef<EditorView | null>(null);
  const refocus = useRef(false);
  const focusOnReady = useRef(true);
  const lastReloadToken = useRef(reloadToken);
  const failedKind = useRef<Write["kind"]>("save");
  const checkingWriteAgain = useRef(false);
  const pendingAutosave = useRef<Promise<boolean> | null>(null);

  const update = useCallback((next: Snapshot) => {
    if (!mounted.current) return;
    const oldLock = locked(current.current);
    current.current = next;
    ordinarySnapshot.current = next;
    setSnapshot(next);
    const newLock = locked(next);
    if (oldLock !== newLock) callbacks.current.onLockChange(newLock);
  }, []);

  const isCurrent = useCallback((number: number) => mounted.current && number === generation.current, []);

  const beginOrdinary = useCallback(() => {
    const activity = ordinary.current;
    activity.generation++;
    baseGeneration.current++;
    activity.active++;
    return () => {
      activity.active--;
      if (mounted.current && ordinary.current === activity) setSyncWake((n) => n + 1);
    };
  }, []);

  useLayoutEffect(() => {
    latestSyncToken.current = Math.max(latestSyncToken.current, syncRefreshToken);
  }, [syncRefreshToken]);

  const read = useCallback(async () => {
    const end = beginOrdinary();
    const number = ++generation.current;
    captureCurrent.current = initialCapture;
    setCaptureUI(initialCapture);
    update({ state: "loading" });
    try {
      const detail = await getWorkingState(chapterId);
      if (isCurrent(number)) update(fromRead(detail));
    } catch {
      if (isCurrent(number)) update({ state: "failed" });
    } finally {
      end();
    }
  }, [chapterId, isCurrent, update, beginOrdinary]);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
      generation.current++;
      baseGeneration.current++;
      ordinary.current = { generation: 0, active: 0 };
      syncInFlight.current = null;
      pendingAutosave.current = null;
      captureAttempt.current = null;
      captureCurrent.current = initialCapture;
      focusRequest.current = null;
      editor.current = null;
      refocus.current = false;
      focusOnReady.current = true;
    };
  }, [read]);

  useEffect(() => {
    const snapshot = autosaveBasis;
    if (snapshot.state !== "ready" || !due(snapshot) || snapshot.stopped || busy(snapshot) || snapshot.autosaveInFlight) {
      return;
    }

    const book = snapshot.bookId;
    const number = generation.current;
    const timer = window.setTimeout(() => {
      if (!isCurrent(number) || ordinarySnapshot.current !== snapshot || current.current.state !== "ready") return;
      const end = beginOrdinary();
      const docSent = snapshot.doc;
      const content = serializeBlocks(docToBlocks(docSent));
      const baseVersion = snapshot.loadedVersionId;
      const baseRevision = snapshot.headRevision;
      update({ ...current.current, autosaveInFlight: true, lastPutStartAt: Date.now() });

      pendingAutosave.current = saveDraft().finally(end);
      async function saveDraft() {
        let revision: number | null = null;
        let conflict: Coordinates | null = null;
        let stale = false;
        let syncReply: ChapterSync | undefined;
        try {
          const result = await putDraft(chapterId, content, baseVersion, baseRevision);
          if (result.chapter?.id === chapterId && result.chapter.book_id === book &&
              result.base_version === baseVersion && result.revision === baseRevision + 1 && validRevision(result.revision)) {
            revision = result.revision;
            syncReply = result.sync;
          }
        } catch (error) {
          if (!isCurrent(number)) return false;
          if (error instanceof ApiError && error.code === "conflict") {
            stale = true;
            conflict = conflictBase(error);
            try {
              const head = await getWorkingState(chapterId, book);
              syncReply = head.sync;
              const { draft } = head;
              if (head.version) conflict = { base_version: head.version.id, base_revision: draft?.revision ?? 0 };
              if (draft !== null && draft.content === content && draft.base_version === baseVersion) {
                revision = draft.revision;
              }
            } catch {
              // A failed adoption read leaves the conflict unresolved.
            }
          }
        }

        const s = current.current;
        if (!isCurrent(number) || s.state !== "ready") return false;
        pendingAutosave.current = null;
        const now = Date.now();
        // Check again may have found a landed write while this request was in flight.
        if (s.loadedVersionId !== baseVersion) {
          update({ ...s, autosaveInFlight: false });
          return false;
        }
        const settled = { ...s, autosaveInFlight: false, sync: syncReply ?? s.sync };
        if (revision !== null) {
          const saved = { ...settled, headRevision: revision, persistedDoc: docSent, persistedRaw: content, failedAt: null };
          update(due(saved) ? { ...saved, dirtySince: now } : saved);
        } else if (stale) {
          update({ ...settled, stopped: true, conflictBase: conflict, persistedDoc: null, persistedRaw: null });
        } else {
          update({ ...settled, failedAt: now });
        }
        return revision !== null && !stale;
      }
    }, Math.max(0, fireAt(snapshot) - Date.now()));

    return () => window.clearTimeout(timer);
  }, [chapterId, isCurrent, autosaveBasis, update, beginOrdinary]);

  function beginBusy(s: Ready, phase: Phase, write: Write | null, restoreFocus = true) {
    if (editor.current) {
      refocus.current = restoreFocus && editor.current.hasFocus();
      editor.current.setProps({ editable: () => false });
    }
    update({ ...s, phase, write, outcome: null });
  }

  function finishBusy() {
    const view = editor.current;
    if (view) {
      view.setProps({ editable: () => true });
      if (refocus.current && (document.activeElement === document.body || view.hasFocus())) view.focus();
    }
    refocus.current = false;
  }

  function settle(number: number, write: Write, result: WriteResult) {
    if (!isCurrent(number) || current.current.state !== "ready") return;
    const s = current.current;
    const outcome = write.kind === "send" ? "sent" : "saved";
    const live = result.current;
    const matches = live.version_id === result.version.id && live.revision === 0;
    const previous = document.activeElement;
    if (previous === writeCheckButton.current) {
      focusRequest.current = { previous, target: matches ? (write.kind === "send" ? "send" : "save") : "reload" };
    }
    update(matches ? {
      ...s, loadedVersionId: result.version.id, activeVersionId: live.active_version_id, sync: live.sync,
      baselineDoc: write.doc, baselineRaw: write.request.content, phase: null, write: null, outcome,
      headRevision: 0, persistedDoc: null, persistedRaw: null, stopped: false, conflictBase: null,
      competingDraft: false, reloadFailed: false, failedAt: null, lastPutStartAt: null,
    } : { ...s, phase: null, write: null, outcome, stopped: true, conflictBase: writeBase(result),
      competingDraft: false, persistedDoc: null, persistedRaw: null });
    finishBusy();
    if (isCurrent(number)) callbacks.current.onWritten();
  }

  async function check(number: number, write: Write) {
    if (!isCurrent(number) || current.current.state !== "ready") return;
    update({ ...current.current, phase: "checking", write });
    let result: WriteResult | null = null;
    try {
      result = await getWriteReceipt({ chapter: chapterId, book: write.book, operation: write.kind,
        requestId: write.request.request_id, parent: write.request.parent_version });
    } catch { /* The attempted write remains unconfirmed. */ }
    if (!isCurrent(number) || current.current.state !== "ready") return;
    if (result) settle(number, write, result);
    else {
      update({ ...current.current, phase: "check-failed" });
      finishBusy();
    }
  }

  async function start(kind: Write["kind"]) {
    const s = current.current;
    const keepMine = kind === "keep_mine";
    if (!mounted.current || s.state !== "ready" || !(keepMine ? keepMineActive(s) : active(s, kind))) return;
    changeCapture(initialCapture);
    failedKind.current = kind;
    const doc = s.doc;
    const content = serializeBlocks(docToBlocks(doc));
    const number = generation.current;
    const end = beginOrdinary();
    try {
      beginBusy(s, kind === "send" ? "sending" : "saving", null);
      const pending = pendingAutosave.current;
      const autosaved = pending === null || await pending;
      if (!isCurrent(number) || current.current.state !== "ready") return;
      const latest = current.current;
      if (!keepMine && (!autosaved || latest.stopped)) {
        update({ ...latest, phase: latest.stopped ? null : "write-failed" });
        finishBusy();
        return;
      }
      if (keepMine && latest.conflictBase === null) {
        // Establish the coordinates first. The next explicit choice can use them.
        try {
          const result = await getWorkingState(chapterId, latest.bookId);
          if (isCurrent(number) && result.version && current.current.state === "ready") {
            update({ ...current.current, phase: null,
              conflictBase: { base_version: result.version.id, base_revision: result.draft?.revision ?? 0 } });
          }
        } catch { /* Reload and clipboard remain available. */ }
        if (isCurrent(number) && current.current.state === "ready") {
          update({ ...current.current, phase: null });
          finishBusy();
        }
        return;
      }
      const base = keepMine ? latest.conflictBase! : {
        base_version: latest.loadedVersionId, base_revision: latest.headRevision,
      };
      let requestId: string;
      try { requestId = globalThis.crypto.randomUUID(); }
      catch {
        update({ ...latest, phase: "write-failed" });
        finishBusy();
        return;
      }
      const request = { ...base, request_id: requestId, parent_version: s.loadedVersionId, content };
      const write = { kind, doc, request, book: s.bookId };
      update({ ...latest, write });
      let result: WriteResult;
      try {
        result = await writeChapter(chapterId, s.bookId, kind, request);
      } catch (error) {
        if (!isCurrent(number) || current.current.state !== "ready") return;
        const live = current.current;
        if (error instanceof ApiError && error.status === 409 && error.code === "conflict") {
          update({ ...live, phase: null, write: null, stopped: true, conflictBase: conflictBase(error),
            competingDraft: false, persistedDoc: null, persistedRaw: null });
          finishBusy();
        } else if (isDefiniteWriteFailure(error)) {
          const competingDraft = error instanceof ApiError && error.code === "write_conflict"
            && detailsObject(error.details)?.reason === "draft_preserved";
          update({ ...live, phase: competingDraft ? null : "write-failed", competingDraft });
          finishBusy();
        } else await check(number, write);
        return;
      }
      settle(number, write, result);
    } finally {
      end();
    }
  }

  function checkAgain() {
    const s = current.current;
    if (s.state !== "ready" || s.capturing || s.phase !== "check-failed" || s.write === null) return;
    changeCapture(initialCapture);
    const number = generation.current;
    const end = beginOrdinary();
    checkingWriteAgain.current = true;
    beginBusy(s, "checking", s.write);
    void check(number, s.write).finally(() => { checkingWriteAgain.current = false; end(); });
  }

  async function reloadLatest(inPlace = false) {
    const s = current.current;
    if (!mounted.current || s.state !== "ready") return;
    if (inPlace) {
      if (s.stopped || locked(s) || s.autosaveInFlight) return;
    } else if (!s.stopped || busy(s)) {
      return;
    }
    if (captureCurrent.current.form && captureCurrent.current.phase === "idle") changeCapture({ ...captureCurrent.current, form:false, name:"", invalid:false, failure:"" });
    const end = beginOrdinary();
    const number = ++generation.current;
    beginBusy({ ...s, reloadFailed: false }, "reloading", s.write, !inPlace);
    try {
      const detail = await getWorkingState(chapterId, s.bookId);
      if (!isCurrent(number)) return;
      if (inPlace && restoredVersionId !== undefined && (detail.version?.id !== restoredVersionId || detail.draft !== null)) {
        throw new Error("Restored Draft has advanced");
      }
      const next = fromRead(detail);
      refocus.current = false;
      focusOnReady.current = !inPlace;
      const ui = captureCurrent.current;
      changeCapture({ ...initialCapture, status:ui.status, failure:ui.failure === copy["draft.snapshot.unconfirmed"] ? ui.failure : "" });
      update({ ...next, editorKey: number });
    } catch {
      if (!isCurrent(number)) return;
      update({ ...s, stopped: true, reloadFailed: true });
      finishBusy();
    } finally {
      end();
    }
  }

  useEffect(() => {
    if (lastReloadToken.current === reloadToken) return;
    lastReloadToken.current = reloadToken;
    void reloadLatest(true);
  }, [reloadToken, reloadLatest]);

  useEffect(() => {
    const token = latestSyncToken.current;
    const s = current.current;
    const activity = ordinary.current;
    if (!mounted.current || token <= handledSyncToken.current || syncInFlight.current !== null
        || activity.active !== 0 || snapshot.state !== "ready" || snapshot.phase !== null || snapshot.stopped
        || s.state !== "ready" || s.phase !== null || s.stopped) return;
    const attempt = { token, generation: activity.generation };
    syncInFlight.current = attempt;
    async function refresh() {
      let sync: ChapterSync | null = null;
      try {
        sync = await getDraftSync(chapterId);
      } catch {
        // A current failed metadata read is handled without changing the Draft.
      }
      if (syncInFlight.current !== attempt) return;
      syncInFlight.current = null;
      if (!mounted.current || ordinary.current !== activity) return;
      if (latestSyncToken.current === attempt.token && activity.generation === attempt.generation) {
        handledSyncToken.current = attempt.token;
        const latest = current.current;
        if (sync !== null && latest.state === "ready") {
          const next = { ...latest, sync };
          current.current = next;
          setSnapshot(next);
        }
      }
      setSyncWake((n) => n + 1);
    }
    void refresh();
  }, [chapterId, snapshot, syncRefreshToken, syncWake]);

  // The chip projection and the base check are independent. Only the notice's clean,
  // idle editor can adopt new metadata; no writer action waits for these reads.
  useEffect(() => {
    const token = latestSyncToken.current;
    if (token <= handledBaseToken.current) return;
    handledBaseToken.current = token;
    const s = current.current;
    const view = editor.current;
    if (!mounted.current || !view || s.state !== "ready" || dirty(s) || s.phase !== null ||
        s.stopped || s.capturing || s.autosaveInFlight || ordinary.current.active !== 0) return;
    const doc = view.state.doc;
    const raw = s.persistedDoc && s.doc.eq(s.persistedDoc) && s.persistedRaw !== null ? s.persistedRaw : s.baselineRaw;
    const original = s.doc, number = generation.current, checkGeneration = baseGeneration.current;
    const activity = ordinary.current;
    const currentAttempt = () => {
      const live = current.current;
      return mounted.current && generation.current === number && editor.current === view &&
        view.state.doc === doc && baseGeneration.current === checkGeneration &&
        latestSyncToken.current === token && ordinary.current === activity && activity.active === 0 &&
        live.state === "ready" && live.doc === original && !dirty(live) && live.phase === null &&
        !live.stopped && !live.capturing && !live.autosaveInFlight &&
        (live.persistedDoc && live.doc.eq(live.persistedDoc) && live.persistedRaw !== null ? live.persistedRaw : live.baselineRaw) === raw;
    };
    const book = s.bookId;
    async function verifyBase() {
      try {
        const detail = await getWorkingState(chapterId, book);
        if (!currentAttempt() || detail.version === null || detail.version.content !== raw ||
            (detail.draft !== null && detail.draft.content !== raw)) return;
        const live = current.current;
        if (live.state !== "ready") return;
        const next = { ...live, loadedVersionId: detail.version.id, activeVersionId: detail.active_version_id,
          headRevision: detail.draft?.revision ?? 0, baselineRaw: raw,
          persistedDoc: detail.draft === null ? null : live.doc, persistedRaw: detail.draft === null ? null : raw };
        // No Editor reconstruction, focus operation, timer reset, chip update or notice.
        current.current = next;
        ordinarySnapshot.current = next;
        setSnapshot(next);
      } catch { /* Background verification leaves the previous guards intact. */ }
    }
    void verifyBase();
  }, [chapterId, syncRefreshToken]);

  // A stopped ordinary autosave dismisses an idle capture form.
  useLayoutEffect(() => {
    if (snapshot.state === "ready" && snapshot.stopped && captureCurrent.current.form && captureCurrent.current.phase === "idle") {
      formFocus("reload");
      changeCapture({ ...captureCurrent.current, form:false, name:"", invalid:false, failure:"" });
    }
  }, [snapshot]);

  function openSnapshot() {
    if (!captureEligible(current.current) || captureCurrent.current.form) return;
    const previous = document.activeElement;
    focusRequest.current = { previous, target:"input" };
    changeCapture({ ...initialCapture, form:true, status:captureCurrent.current.status });
  }
  function closeSnapshot() {
    if (!captureCurrent.current.form || captureCurrent.current.phase !== "idle") return;
    formFocus("snapshot");
    changeCapture({ ...initialCapture, status:captureCurrent.current.status });
  }
  function editName(name: string) {
    const ui=captureCurrent.current;
    if (ui.phase !== "idle") return;
    changeCapture({ ...ui, name, invalid:false, failure:ui.invalid ? "" : ui.failure });
  }
  function liveCapture(a: CaptureAttempt) {
    return captureAttempt.current === a && isCurrent(a.number) && current.current.state === "ready";
  }
  function releaseCapture(a: CaptureAttempt, next: Ready, ui: CaptureUI) {
    if (!liveCapture(a)) return;
    captureAttempt.current = null;
    changeCapture(ui);
    update({ ...next, capturing:false });
    editor.current?.setProps({ editable: () => true });
    a.end();
  }
  function captureFailure(a: CaptureAttempt, failure: string, invalid = false, conflict = false) {
    if (!liveCapture(a) || current.current.state !== "ready") return;
    const s=current.current;
    if (conflict) formFocus("reload");
    const ui=captureCurrent.current;
    releaseCapture(a, conflict ? { ...s, stopped:true } : s,
      { ...ui, form:conflict ? false : ui.form, phase:"idle", status:"", failure, invalid, conflict });
  }
  function confirmCapture(a: CaptureAttempt, result: CaptureResult) {
    if (!liveCapture(a) || current.current.state !== "ready" || !a.body) return;
    const s=current.current;
    formFocus(result.draft_current ? "snapshot" : "reload");
    let next: Ready = s;
    if (result.draft_current) {
      next = { ...s, activeVersionId:result.active_version_id, sync:result.sync };
      if (result.created_version) next = { ...next, loadedVersionId:result.version.id, baselineDoc:a.doc, baselineRaw:a.body.content,
        headRevision:0, persistedDoc:null, persistedRaw:null, failedAt:null, lastPutStartAt:null, outcome:null };
    } else next = { ...s, stopped:true };
    releaseCapture(a,next,{ ...initialCapture, status:copy["draft.snapshot.saved"], failure:result.draft_current ? "" : copy["draft.snapshot.conflict"], conflict:!result.draft_current });
    if (isCurrent(a.number)) callbacks.current.onWritten();
  }
  async function lookupCapture(a: CaptureAttempt, manual = false) {
    if (!liveCapture(a) || !a.body) return;
    changeCapture({ ...captureCurrent.current, phase:manual ? "manual" : "checking", status:copy["draft.snapshot.checking"], failure:"" });
    let result: CaptureResult | null = null;
    try { result=await getSnapshotCapture(chapterId,a.body.request_id); } catch { /* absence and errors are unconfirmed */ }
    if (!liveCapture(a)) return;
    if (result) { confirmCapture(a,result); return; }
    const previous=document.activeElement;
    // Only controls that disappear hand focus to Check again. The name survives.
    if (snapshotForm.current?.contains(previous) && previous !== snapshotName.current)
      focusRequest.current={ previous,target:"check" };
    changeCapture({ ...captureCurrent.current, phase:"unknown", status:"", failure:copy["draft.snapshot.unconfirmed"] });
  }
  function checkSnapshotAgain() {
    const a=captureAttempt.current;
    if (!a || captureCurrent.current.phase !== "unknown") return;
    void lookupCapture(a,true);
  }
  function returnToDraft() {
    const a=captureAttempt.current;
    if (!a || !liveCapture(a) || captureCurrent.current.phase !== "unknown" || current.current.state !== "ready") return;
    formFocus("reload");
    releaseCapture(a,{ ...current.current, stopped:true },{ ...initialCapture, failure:copy["draft.snapshot.unconfirmed"] });
  }
  async function startSnapshot(fromForm = false) {
    const s=current.current, ui=captureCurrent.current;
    if (!mounted.current || !captureEligible(s) || ui.phase !== "idle" || fromForm !== ui.form) return;
    const a: CaptureAttempt = { number:generation.current, doc:s.doc, name:fromForm && ui.name !== "" ? ui.name : undefined, body:null, end:beginOrdinary() };
    captureAttempt.current=a;
    changeCapture({ ...ui, phase:"taking", status:copy["draft.snapshot.taking"], failure:"", invalid:false, conflict:false });
    editor.current?.setProps({ editable:() => false });
    update({ ...s, capturing:true, outcome:null });
    const pending=pendingAutosave.current;
    if (pending) {
      await pending;
      if (!liveCapture(a) || current.current.state !== "ready") return;
      const latest=current.current;
      if (latest.stopped) {
        formFocus("reload");
        releaseCapture(a,latest,{ ...initialCapture });
        return;
      }
      if (latest.failedAt !== null || latest.persistedDoc === null || latest.headRevision === 0) {
        captureFailure(a,copy["draft.snapshot.finishDraft"]); return;
      }
    }
    if (!liveCapture(a) || current.current.state !== "ready") return;
    const confirmed=current.current;
    let requestId: string;
    try { requestId=globalThis.crypto.randomUUID(); }
    catch { captureFailure(a,copy["draft.snapshot.startFailed"]); return; }
    const content=confirmed.persistedDoc && a.doc.eq(confirmed.persistedDoc) && confirmed.persistedRaw !== null ? confirmed.persistedRaw :
      a.doc.eq(confirmed.baselineDoc) ? confirmed.baselineRaw : serializeBlocks(docToBlocks(a.doc));
    a.body={ request_id:requestId, content, base_version:confirmed.loadedVersionId, base_revision:confirmed.headRevision, ...(a.name === undefined ? {} : { name:a.name }) };
    let result: CaptureResult | null;
    try { result=await captureSnapshot(chapterId,a.body); }
    catch(error) {
      if (!liveCapture(a)) return;
      if (error instanceof ApiError) {
        const details=detailsObject(error.details);
        const reason=details?.reason;
        if (error.status === 400 && error.code === "validation_failed" && hasDetail(error,"/name")) {
          captureFailure(a,copy["draft.snapshot.invalid"],fromForm); return;
        }
        if (error.status === 400 && error.code === "validation_failed" && hasDetail(error,"/content","nothing to capture")) {
          captureFailure(a,copy["draft.snapshot.empty"]); return;
        }
        if (error.status === 409 && error.code === "conflict" && (reason === "version" || reason === "revision") && typeof details?.current_version === "string" && /^ver_[0-9a-f]{12}$/.test(details.current_version) && typeof details.current_revision === "number" && Number.isInteger(details.current_revision) && details.current_revision >= 0) {
          captureFailure(a,copy["draft.snapshot.conflict"],false,true); return;
        }
        if (error.status === 409 && error.code === "snapshot_conflict") {
          const failure=reason === "name_exists" ? copy["draft.snapshot.nameExists"] :
            reason === "released_book" ? copy["draft.snapshot.released"] : reason === "scene_hints" ? copy["draft.snapshot.hints"] :
            reason === "request_mismatch" ? copy["draft.snapshot.failed"] : null;
          if (failure) { captureFailure(a,failure); return; }
        }
        if ((error.status === 400 && error.code === "validation_failed") || (error.status === 401 && error.code === "auth_required") ||
          (error.status === 404 && error.code === "not_found") || (error.status === 413 && error.code === "payload_too_large") ||
          (error.status === 415 && error.code === "unsupported_media_type")) {
          captureFailure(a,copy["draft.snapshot.failed"]); return;
        }
      }
      await lookupCapture(a); return;
    }
    if (!liveCapture(a)) return;
    if (result) confirmCapture(a,result);
    else await lookupCapture(a);
  }

  function docChange(doc: Node) {
    baseGeneration.current++;
    const s = current.current;
    if (s.state !== "ready" || busy(s)) return;
    onDocumentChange?.();
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

  const actions = useRef({ start, startSnapshot });
  actions.current = { start, startSnapshot };
  useEffect(() => {
    function chord(event: KeyboardEvent) {
      if (event.ctrlKey === event.metaKey || event.altKey) return;
      if (event.code === "KeyS" && !event.shiftKey) {
        event.preventDefault();
        if (!event.repeat && !event.isComposing) void actions.current.startSnapshot();
      } else if (event.code === "Enter" && event.shiftKey) {
        event.preventDefault(); void actions.current.start("send");
      }
    }
    window.addEventListener("keydown", chord);
    return () => window.removeEventListener("keydown", chord);
  }, []);

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
      <p className="ax-draft__snapshot-status" role="status" aria-live="polite" aria-atomic="true" data-part="snapshot-status" />
    </section>
  );
  if (snapshot.state === "failed") return (
    <section className="ax-draft" data-surface="draft" data-state="failed" data-autosave="idle">
      <div role="alert" data-part="read-failure">
        <div>{copy["draft.openFailed"]}</div>
        <button type="button" className="ax-button ax-button--secondary" data-part="try-again"
          onClick={() => { if (current.current.state === "failed") void read(); }}>{copy["draft.tryAgain"]}</button>
      </div>
      <p className="ax-draft__snapshot-status" role="status" aria-live="polite" aria-atomic="true" data-part="snapshot-status" />
    </section>
  );

  const s = snapshot;
  const ui=captureUI;
  const snapshotActive=captureEligible(s) && !ui.form;
  const pendingCapture=ui.phase !== "idle";
  const checkingManually=ui.phase === "manual";
  const recovery=ui.phase === "unknown" || checkingManually;
  const state = s.phase ?? (s.stopped ? "conflict" : dirty(s) ? "unsaved" : "clean");
  const showConflict = s.stopped && (s.phase === null || s.phase === "reloading" || s.phase === "write-failed");
  const autosave = autosaveStatus(s);
  const saveActive = active(s, "save");
  const sendActive = active(s, "send");
  const chip = syncChip({ version_id: s.loadedVersionId, active_version_id: s.activeVersionId, sync: s.sync });
  const recoveryWrite = s.phase === "check-failed" || (s.phase === "checking" && s.write !== null && checkingWriteAgain.current);
  const failure = s.phase === "write-failed" || recoveryWrite;
  const outcome = state === "clean" || state === "conflict" ? s.outcome : null;
  const status = state === "unsaved" && (dirty(s) && !kept(s)) ? copy["draft.unsaved"] : state === "saving" ? copy["draft.saving"]
    : state === "sending" ? copy["draft.sending"] : state === "checking" ? copy["draft.checking"]
    : state === "reloading" && s.stopped ? copy["draft.reloading"] : outcome === "saved" ? copy["draft.saved"] : outcome === "sent" ? copy["draft.sent"] : "";
  return (
    <section ref={captureRoot} className="ax-draft" data-surface="draft" data-state={state} data-autosave={autosave}>
      <div className="ax-draft-head" data-part="draft-head">
        <div className="ax-toolbar ax-draft__snapshot-toolbar" data-part="toolbar" role="group">
          {chip !== null && <span className="ax-binder__sync" data-part="version-chip">{chip}</span>}
          <span className="ax-autosave" data-part="autosave" role="status">
            {autosave !== "idle" && autosave !== "saved" &&
              <span className="ax-autosave__dot" data-part="autosave-dot" aria-hidden="true" />}
            {autosave === "failed" ? copy["draft.autosaveFailed"] : null}
          </span>
          {s.phase === null && !s.stopped && <button ref={snapshotButton} className="ax-button ax-button--quiet ax-draft__snapshot" type="button" data-part="snapshot" aria-disabled={!snapshotActive}
            onClick={openSnapshot}><span>{copy["draft.snapshot.action"]}</span></button>}
          <button type="button" ref={saveButton} className="ax-button ax-button--secondary" data-part="save" aria-disabled={!saveActive}
            onClick={() => { void start("save"); }}>{copy["draft.save"]}</button>
          <button type="button" ref={sendButton} className={`ax-button ax-button--${sendActive ? "primary" : "secondary"}`} data-part="send"
            aria-disabled={!sendActive} onClick={() => { void start("send"); }}>{copy["draft.send"]}</button>
        </div>
        {ui.form && <form ref={snapshotForm} className="ax-draft__snapshot-form" data-part="snapshot-form" onSubmit={event => { event.preventDefault(); void startSnapshot(true); }}
          onKeyDown={event => { if (event.key === "Escape" && !pendingCapture) { event.preventDefault(); event.stopPropagation(); closeSnapshot(); } }}>
          <div className="ax-field">
          <label className="ax-field-label" htmlFor={inputId}>{copy["draft.snapshot.label"]}</label>
          <input className="ax-input ax-draft__snapshot-input" ref={snapshotName} id={inputId} data-part="snapshot-name" dir="auto" value={ui.name} readOnly={pendingCapture}
            aria-describedby={inputId+"-hint"+(ui.invalid ? " "+inputId+"-failure" : "")} aria-invalid={ui.invalid || undefined}
            onChange={event=>editName(event.target.value)} />
          <p className="ax-draft__snapshot-hint" id={inputId+"-hint"}>{copy["draft.snapshot.hint"]}</p>
          {ui.invalid && <p className="ax-draft__snapshot-failure" id={inputId+"-failure"} role="alert" data-part="snapshot-failure"><span className="ax-draft__snapshot-error-mark" aria-hidden="true" /><span>{ui.failure}</span></p>}
          </div>
          {!recovery && <div className="ax-draft__snapshot-actions">
            <button className="ax-button ax-button--secondary ax-draft__snapshot-button" type="submit" data-part="snapshot-submit" aria-disabled={pendingCapture}><span>{copy["draft.snapshot.submit"]}</span></button>
            <button className="ax-button ax-button--quiet ax-draft__snapshot-button" type="button" data-part="snapshot-cancel" aria-disabled={pendingCapture} onClick={closeSnapshot}><span>{copy["draft.snapshot.cancel"]}</span></button>
          </div>}
        </form>}
        <p className="ax-draft-status" role="status" data-part="status" data-outcome={outcome ?? undefined}>{status}</p>
        {showConflict && <div className="ax-banner" role="alert" data-part="conflict">
          {!ui.conflict && <p className="ax-banner__lead">{copy[s.competingDraft ? "draft.competingDraft" : "draft.conflict"]}</p>}
          <button type="button" className="ax-button ax-button--secondary" ref={reloadButton} data-part="reload-latest" aria-disabled={isBusy}
            onClick={() => { void reloadLatest(); }}>{copy["draft.reloadLatest"]}</button>
          <button type="button" className="ax-button ax-button--secondary" data-part="keep-mine" aria-disabled={!keepMineActive(s)}
            onClick={() => { void start("keep_mine"); }}>{copy["draft.keepMine"]}</button>
          <button type="button" className="ax-button ax-button--secondary" data-part="conflict-copy"
            onClick={() => { void copyChapter(); }}>{copy["draft.copyChapter"]}</button>
          {s.reloadFailed && <p className="ax-banner__note" role="alert" data-part="reload-failure">{copy["draft.reloadFailed"]}</p>}
        </div>}
        {failure && <div className="ax-banner" role="alert" data-part="write-failure">
          {!recoveryWrite && <span className="ax-banner__mark" data-part="not-saved-mark">{copy["draft.notSaved"]}</span>}
          <p>{copy[recoveryWrite ? "draft.writeUnconfirmed" : s.write?.kind === "send" || failedKind.current === "send" ? "draft.sendFailed" : "draft.saveFailed"]}</p>
          {!kept(s) && <p data-part="only-here">{copy["draft.onlyHere"]}</p>}
          <button type="button" className="ax-button ax-button--secondary" data-part="copy-chapter"
            onClick={() => { void copyChapter(); }}>{copy["draft.copyChapter"]}</button>
          {recoveryWrite && <button type="button" className="ax-button ax-button--secondary" data-part="check-again" ref={writeCheckButton}
            aria-disabled={s.phase === "checking"} onClick={checkAgain}>{copy["draft.checkAgain"]}</button>}
        </div>}
        <div className="ax-draft__snapshot-feedback">
          <p className="ax-draft__snapshot-status" role="status" aria-live="polite" aria-atomic="true" data-part="snapshot-status">{ui.status}</p>
          {ui.failure && !ui.invalid && <p className="ax-draft__snapshot-failure" role="alert" data-part="snapshot-failure">{ui.failure}</p>}
          {recovery && <div className="ax-draft__snapshot-actions">
            <button ref={snapshotCheck} className="ax-button ax-button--secondary ax-draft__snapshot-button" type="button" data-part="snapshot-check-again" aria-disabled={checkingManually} onClick={checkSnapshotAgain}><span>{copy["draft.snapshot.checkAgain"]}</span></button>
            <button ref={snapshotReturn} className="ax-button ax-button--quiet ax-draft__snapshot-button" type="button" data-part="snapshot-return" aria-disabled={checkingManually} onClick={returnToDraft}><span>{copy["draft.snapshot.return"]}</span></button>
          </div>}
        </div>
      </div>
      <div className="ax-draft-page" data-part="page">
        <Editor key={s.editorKey} blocks={s.blocks} editable={!isBusy} onDocChange={docChange} onReady={(view) => {
          editor.current = view;
          if (focusOnReady.current) view.focus();
          focusOnReady.current = true;
          callbacks.current.onEditorReady?.(view);
        }} />
      </div>
    </section>
  );
}
