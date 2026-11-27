import "./history.css";
import "./restore.css";
import "./snapshots.css";
import "./snapshot-lifecycle.css";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { getHistory, getVersion, getWriteReceipt, isDefiniteWriteFailure, restoreVersion, nameSnapshot, validNamedSnapshot, changeSnapshotLabel, validSnapshotLifecycle } from "../api/endpoints";
import type { ChapterHistory, HistoryItem, NamedSnapshot, VersionText, SnapshotLifecycle, SnapshotLabelAction, SnapshotLabelResult, WriteResult } from "../api/types";
import { ApiError } from "../api/http";
import { copy } from "../copy";
import { formatVersionDate, previewBlocks, sourceWord, wordsLabel } from "./historyFormat";

export type RestoreOutcome = { version_id: string; checkpoint_version_id: string | null; draft_current: boolean };
export type OnRestored = (outcome: RestoreOutcome) => "applied" | "kept";

type Props = {
  chapterId: string; seriesId?: string; refreshToken?: number; timeZone?: string; locked?: boolean; onRestored?: OnRestored; onRestoreStart?: () => OnRestored; pendingRestores?: Map<string, RestoreAttempt>;
};
type List = { state: "loading" | "failed" } | { state: "ready"; history: ChapterHistory; refreshFailed: boolean };
type Selection = { id: string; state: "loading" | "failed" } | { id: string; state: "ready"; text: VersionText };
export type RestoreAttempt = { id: string; requestId: string; book: string; notify: OnRestored; disposition?: ReturnType<OnRestored> };
type RestoreOperation = { state: "restoring" | "checking" | "unconfirmed"; attempt: RestoreAttempt };
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
    return item.snapshot_lifecycle === undefined && !item.snapshot && snapshot ? { ...item, snapshot, can_name_snapshot: false } : item;
  }) };
}
type LabelAttempt = { id:string; original:NamedSnapshot; body:SnapshotLabelAction };
type Undo = { original:NamedSnapshot; marker:SnapshotLifecycle };
type LabelUI = {phase:"idle"|"mutating"|"checking"|"unconfirmed"; status:string; failure:string; attempt:LabelAttempt|null; undo:Undo|null};
const initialLabel:LabelUI={phase:"idle",status:"",failure:"",attempt:null,undo:null};
const sameSnapshot=(a:NamedSnapshot|null,b:NamedSnapshot)=>!!a&&a.name===b.name&&a.l_seq===b.l_seq&&a.created_at===b.created_at&&a.chapter_id===b.chapter_id&&a.version_id===b.version_id;
function usableMarker(item:HistoryItem):SnapshotLifecycle|null {
  return validSnapshotLifecycle(item.snapshot_lifecycle) && typeof item.can_name_snapshot==="boolean" &&
    (item.snapshot===null || (savedSnapshot(item)!==null && item.can_name_snapshot===false)) ? item.snapshot_lifecycle:null;
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
  const isCheckpoint = item.source === "checkpoint";
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
        <span className="ax-history__snapshot-key" aria-hidden="true">{isCheckpoint ? "A" : "S"}</span>
        <div><p className="ax-history__snapshot-source">{copy[isCheckpoint ? "history.snapshot.automaticSource" : "history.snapshot.namedSource"]}</p>
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

export function History(props:Props) {
  return <MountedHistory key={props.chapterId} {...props}/>;
}
function MountedHistory({ chapterId, seriesId, refreshToken = 0, timeZone, locked = false, onRestored = keepDraft, onRestoreStart, pendingRestores }: Props) {
  const initialChapter = useRef(chapterId).current;
  const root = useRef<HTMLElement>(null);
  const [list, setList] = useState<List>({ state: "loading" });
  const [labelUI,setLabelUI]=useState<LabelUI>(initialLabel);
  const labelRef=useRef<LabelUI>(initialLabel);
  const manualCheck=useRef(false);
  const labelFocus=useRef<{previous:Element|null;part:string;id?:string}|null>(null);
  const writeGeneration=useRef(0);
  const acceptedRead=useRef(0);
  const latestRefresh=useRef(refreshToken);
  const handledRefresh=useRef(refreshToken);
  const deferredRefresh=useRef(false);
  const [refreshWake,setRefreshWake]=useState(0);
  function changeLabel(next:LabelUI){if(next.phase!=="checking")manualCheck.current=false;labelRef.current=next;setLabelUI(next);}
  function labelBlocked(){return labelRef.current.phase!=="idle";}
  function labelPending(){return labelRef.current.phase==="mutating"||labelRef.current.phase==="checking";}
  const [selection, setSelection] = useState<Selection | null>(null);
  const [restore, setRestore] = useState<RestoreOperation | null>(() => {
    const attempt = pendingRestores?.get(chapterId);
    return attempt ? { state: "unconfirmed", attempt } : null;
  });
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [filter, setFilter] = useState<"named" | "all">("all");
  const filterRef=useRef(filter);
  filterRef.current=filter;
  useLayoutEffect(()=>{
    const next=labelFocus.current;
    if(!next)return;
    labelFocus.current=null;
    if(next.previous?.isConnected)return;
    if(document.activeElement!==document.body && document.activeElement!==next.previous)return;
    const section=root.current;
    const target=next.id
      ?Array.from(section?.querySelectorAll<HTMLElement>('[data-version-id]')??[]).find(el=>el.dataset.versionId===next.id)?.querySelector<HTMLElement>('[data-part="version-open"]')
      :section?.querySelector<HTMLElement>('[data-part="'+next.part+'"]');
    (target??section?.querySelector<HTMLElement>('[data-part="snapshot-'+filterRef.current+'"]')??section)?.focus();
  });
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
    if(next?.phase!=="pending"&&deferredRefresh.current)setRefreshWake(n=>n+1);
  }
  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    if (next.kind === "input") input.current?.focus();
    else if (next.kind === "cancel") cancel.current?.focus();
    else if (next.kind === "opener") {
      if (opener.current?.isConnected) opener.current.focus();
      else {
        const action = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-part="snapshot-name-action"]') ?? [])
          .find(button => button.dataset.targetVersion === next.id);
        (action ?? root.current)?.focus();
      }
    } else {
      const row = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-version-id]") ?? [])
        .find(el => el.dataset.versionId === next.id);
      (row?.querySelector<HTMLElement>('[data-part="version-open"]') ?? root.current)?.focus();
    }
  }, [naming]);
  const operation = useRef(restore);
  const latestHistoryRead = useRef(0);
  const versionGeneration = useRef(0);
  const cache = useRef(new Map<string, VersionText>());
  const pending = useRef(new Set<string>());

  const changeRestore = useCallback((next: RestoreOperation | null) => {
    operation.current = next;
    setRestore(next);
  }, []);

  function readGuard(read:number,generation:number) {
    return live.current && generation===writeGeneration.current && read>=acceptedRead.current;
  }
  function setHistory(history:ChapterHistory) {
    setList(previous=>({state:"ready",history:carryNames(previous,history),refreshFailed:false}));
    setSelection(previous=>previous&&history.versions.some(row=>row.id===previous.id&&(filterRef.current==="all"||row.snapshot_lifecycle===undefined||!!savedSnapshot(row)))?previous:null);
  }
  function currentUndo(history:ChapterHistory,undo:Undo|null):Undo|null {
    if(!undo)return null;
    const row=history.versions.find(v=>v.id===undo.original.version_id&&v.chapter_id===initialChapter);
    if(!row||row.snapshot_lifecycle===undefined)return undo;
    const m=usableMarker(row);
    if(!m)return row.snapshot_lifecycle===null&&row.snapshot===null?null:undo;
    return row.snapshot===null&&m.snapshot_id===undo.marker.snapshot_id&&m.state_token===undo.marker.state_token?undo:null;
  }
  function rememberFocus(part:string,id?:string) {
    const previous=document.activeElement;
    if(previous&&root.current?.contains(previous))labelFocus.current={previous,part,id};
  }
  function patchLabel(reply:SnapshotLabelResult) {
    setList(previous=>previous.state!=="ready"?previous:{...previous,history:{...previous.history,versions:previous.history.versions.map(row=>
      row.id===reply.version_id&&row.chapter_id===reply.chapter_id?{...row,snapshot:reply.snapshot,snapshot_lifecycle:reply.snapshot_lifecycle,can_name_snapshot:reply.can_name_snapshot}:row)}});
    if(reply.snapshot===null&&filterRef.current==="named")setSelection(previous=>previous?.id===reply.version_id?null:previous);
  }
  function finishLabel(a:LabelAttempt,reply:SnapshotLabelResult,history?:ChapterHistory) {
    if(!live.current||labelRef.current.attempt!==a)return;
    const removed=a.body.action==="remove";
    rememberFocus(removed?"snapshot-remove-undo":"version-open",removed?undefined:a.id);
    if(history)setHistory(history);else patchLabel(reply);
    changeLabel({phase:"idle",attempt:null,status:copy[removed?"history.snapshotLifecycle.removed":"history.snapshotLifecycle.restored"],failure:"",
      undo:removed?{original:a.original,marker:reply.snapshot_lifecycle}:null});
    setRefreshWake(n=>n+1);
  }
  function uncertain(a:LabelAttempt) {
    if(!live.current||labelRef.current.attempt!==a)return;
    rememberFocus("snapshot-lifecycle-check");
    changeLabel({...labelRef.current,phase:"unconfirmed",status:"",failure:copy["history.snapshotLifecycle.unconfirmed"]});
    setRefreshWake(n=>n+1);
  }
  function adjudicate(a:LabelAttempt,history:ChapterHistory) {
    const row=history.chapter.id===initialChapter?history.versions.find(v=>v.id===a.id&&v.chapter_id===initialChapter&&v.l_seq===a.original.l_seq):undefined;
    const marker=row&&usableMarker(row);
    if(!row||!marker){uncertain(a);return;}
    const original= a.body.action==="remove"?sameSnapshot(savedSnapshot(row),a.original):row.snapshot===null;
    const wanted= a.body.action==="remove"?row.snapshot===null:sameSnapshot(savedSnapshot(row),a.original);
    if(marker.snapshot_id===a.body.snapshot_id&&marker.state_token===a.body.expected_token&&!original){uncertain(a);return;}
    if(marker.snapshot_id===a.body.snapshot_id&&marker.state_token!==a.body.expected_token&&marker.previous_token===a.body.expected_token&&wanted){
      finishLabel(a,{chapter_id:initialChapter,version_id:a.id,snapshot_lifecycle:marker,snapshot:row.snapshot??null,can_name_snapshot:row.can_name_snapshot===true},history);return;
    }
    rememberFocus("version-open",a.id);
    setHistory(history);
    const unchanged=marker.snapshot_id===a.body.snapshot_id&&marker.state_token===a.body.expected_token&&original;
    changeLabel({phase:"idle",attempt:null,status:"",failure:copy[unchanged?"history.snapshotLifecycle.unconfirmed":"history.snapshotLifecycle.changed"],undo:currentUndo(history,labelRef.current.undo)});
    setRefreshWake(n=>n+1);
  }
  async function settleLabel(a:LabelAttempt) {
    if(!live.current||labelRef.current.attempt!==a)return;
    changeLabel({...labelRef.current,phase:"checking",status:copy["history.snapshotLifecycle.checking"],failure:""});
    const read=++latestHistoryRead.current,generation=writeGeneration.current;
    try{
      const history=await getHistory(initialChapter);
      if(!readGuard(read,generation)||labelRef.current.attempt!==a)return;
      acceptedRead.current=read;
      adjudicate(a,history);
    }catch{if(readGuard(read,generation)&&labelRef.current.attempt===a){acceptedRead.current=read;uncertain(a);}}
  }
  async function startLabel(a:LabelAttempt) {
    if(!live.current||labelBlocked()||operation.current||namingRef.current)return;
    ++writeGeneration.current;
    changeLabel({...labelRef.current,phase:"mutating",attempt:a,status:copy[a.body.action==="remove"?"history.snapshotLifecycle.removing":"history.snapshotLifecycle.restoring"],failure:""});
    try {
      const reply=await changeSnapshotLabel(initialChapter,a.id,a.body);
      if(!live.current||labelRef.current.attempt!==a)return;
      if(reply&&(a.body.action==="remove"||sameSnapshot(reply.snapshot,a.original))){finishLabel(a,reply);return;}
    }catch{/* All failures require one authoritative read. */}
    if(live.current&&labelRef.current.attempt===a)await settleLabel(a);
  }
  function removeLabel(item:HistoryItem) {
    const original=savedSnapshot(item),marker=usableMarker(item);
    if(original&&marker)void startLabel({id:item.id,original,body:{action:"remove",snapshot_id:marker.snapshot_id,expected_token:marker.state_token}});
  }
  function undoLabel() {
    const undo=labelRef.current.undo;
    if(undo)void startLabel({id:undo.original.version_id,original:undo.original,body:{action:"undo",snapshot_id:undo.marker.snapshot_id,expected_token:undo.marker.state_token,name:undo.original.name}});
  }
  function checkLabel(){
    const a=labelRef.current.attempt;
    if(labelRef.current.phase==="unconfirmed"&&a){manualCheck.current=true;void settleLabel(a);}
  }

  const readHistory = async () => {
    if(labelPending()||namingRef.current?.phase==="pending"){deferredRefresh.current=true;return;}
    const read = ++latestHistoryRead.current;
    const generation=writeGeneration.current;
    setList((previous) => previous.state === "ready"
      ? { ...previous, refreshFailed: false }
      : { state: "loading" });
    let history: ChapterHistory;
    try {
      history = await getHistory(initialChapter);
    } catch {
      if (!readGuard(read,generation)||labelPending()) return;
      acceptedRead.current=read;
      if(labelRef.current.phase==="unconfirmed"&&labelRef.current.attempt)uncertain(labelRef.current.attempt);
      setList((previous) => previous.state === "ready"
        ? { ...previous, refreshFailed: true }
        : { state: "failed" });
      return;
    }
    if (!readGuard(read,generation)||labelPending()) return;
    acceptedRead.current=read;
    if(!history||history.chapter?.id!==initialChapter||!Array.isArray(history.versions)){if(labelRef.current.phase==="unconfirmed"&&labelRef.current.attempt)uncertain(labelRef.current.attempt);else setList(previous=>previous.state==="ready"?{...previous,refreshFailed:true}:{state:"failed"});return;}
    if(labelRef.current.phase==="unconfirmed"&&labelRef.current.attempt){adjudicate(labelRef.current.attempt,history);return;}
    setHistory(history);
    const undo=currentUndo(history,labelRef.current.undo);
    if(undo!==labelRef.current.undo){rememberFocus("version-open",labelRef.current.undo?.original.version_id);changeLabel({...labelRef.current,undo});}

  };

  useEffect(() => () => {
    latestHistoryRead.current++;
    versionGeneration.current++;
    cache.current.clear();
    pending.current.clear();
  }, []);

  useEffect(()=>{void readHistory();},[]);
  useEffect(()=>{
    latestRefresh.current=refreshToken;
    if(refreshToken!==handledRefresh.current)deferredRefresh.current=true;
    if(deferredRefresh.current&&!labelPending()&&namingRef.current?.phase!=="pending"){
      deferredRefresh.current=false;
      handledRefresh.current=latestRefresh.current;
      void readHistory();
    }
  },[refreshToken,refreshWake]);

  async function readVersion(id: string) {
    setSelection({ id, state: "loading" });
    if (pending.current.has(id)) return;
    pending.current.add(id);
    const generation = versionGeneration.current;
    try {
      const book = list.state === "ready" ? list.history.chapter.book_id : undefined;
      const text = await getVersion(initialChapter, id, book);
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

  function currentRestore(attempt: RestoreAttempt) {
    return live.current && operation.current?.attempt === attempt;
  }

  function confirmRestore(attempt: RestoreAttempt, written: WriteResult) {
    if (pendingRestores?.get(initialChapter) === attempt) pendingRestores.delete(initialChapter);
    const checkpoint = written.checkpoint_version_id;
    const current = written.current.version_id === written.version.id && written.current.revision === 0;
    attempt.disposition ??= attempt.notify({
      version_id: written.version.id, checkpoint_version_id: checkpoint, draft_current: current,
    });
    if (!currentRestore(attempt)) return;
    rememberFocus("version-open", attempt.id);
    changeRestore(null);
    setResult(restoreStatus(current ? attempt.disposition : "kept", checkpoint));
    deferredRefresh.current = true;
    setRefreshWake((token) => token + 1);
  }

  async function checkRestore(attempt: RestoreAttempt) {
    if (!currentRestore(attempt)) return;
    changeRestore({ state: "checking", attempt });
    let written: WriteResult | null = null;
    try {
      written = await getWriteReceipt({ chapter: initialChapter, book: attempt.book,
        operation: "restore", requestId: attempt.requestId, source: attempt.id });
    } catch { /* The receipt can still become visible after an uncertain response. */ }
    if (!currentRestore(attempt)) return;
    if (written) confirmRestore(attempt, written);
    else {
      changeRestore({ state: "unconfirmed", attempt });
      setResult({ part: "restore-failure", message: copy["history.restoreUnconfirmed"] });
    }
  }

  async function pressRestore(item: HistoryItem) {
    if (locked || operation.current !== null || labelPending() || namingRef.current?.phase === "pending" || list.state !== "ready") return;
    let requestId: string;
    try { requestId = globalThis.crypto.randomUUID(); }
    catch {
      setResult({ part: "restore-failure", message: copy["history.restoreFailed"] });
      return;
    }
    const attempt = { id: item.id, book: list.history.chapter.book_id, requestId, notify: onRestoreStart?.() ?? onRestored };
    pendingRestores?.set(initialChapter, attempt);
    changeRestore({ state: "restoring", attempt });
    setResult(null);
    let written: WriteResult;
    try {
      written = await restoreVersion(initialChapter, attempt.book, item.id, requestId);
    } catch (error) {
      if (isDefiniteWriteFailure(error)) {
        if (pendingRestores?.get(initialChapter) === attempt) pendingRestores.delete(initialChapter);
        if (currentRestore(attempt)) {
          changeRestore(null);
          setResult({ part: "restore-failure", message: copy["history.restoreFailed"] });
        }
      } else await checkRestore(attempt);
      return;
    }
    confirmRestore(attempt, written);
  }

  function eligible(item: HistoryItem) {
    return !!seriesId && item.can_name_snapshot === true && !item.snapshot;
  }

  function openNaming(item: HistoryItem, button: HTMLButtonElement) {
    if (!eligible(item) || labelPending() || operation.current || namingRef.current?.phase === "pending" || namingRef.current?.phase === "settled") return;
    opener.current = button;
    focusNext.current = { kind: "input" };
    setNameStatus("");
    changeNaming({ chapter: initialChapter, id: item.id, number: item.version_no, cut: item.l_seq, value: "", phase: "editing" });
  }
  function closeNaming() {
    if (!namingRef.current || namingRef.current.phase === "pending") return;
    focusNext.current = { kind: "opener", id: namingRef.current.id };
    setNameStatus("");
    changeNaming(null);
  }
  function mergeSnapshot(snapshot: NamedSnapshot, metadata?: SnapshotLifecycle | null) {
    setList(previous => previous.state !== "ready" ? previous : {
      ...previous, history: { ...previous.history, versions: previous.history.versions.map(row =>
        row.id === snapshot.version_id && row.chapter_id === snapshot.chapter_id && row.l_seq === snapshot.l_seq
          ? { ...row, snapshot, snapshot_lifecycle:metadata, can_name_snapshot: false } : row) }
    });
  }
  async function submitNaming() {
    const target = namingRef.current;
    if (labelPending() || operation.current || !seriesId || !target || target.phase !== "editing" || target.noRetry || list.state !== "ready"
      || !list.history.versions.some(row => row.id === target.id && row.l_seq === target.cut && eligible(row))) return;
    ++writeGeneration.current;
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
        void readHistory();
        return;
      }
    } catch (e) { error = e; }
    if (!stillLive()) return;
    let snapshot: NamedSnapshot | null = null;
    let confirmedIneligible = false;
    let settledMetadata:SnapshotLifecycle|null|undefined;
    try {
      const read=++latestHistoryRead.current,generation=writeGeneration.current;
      const settled = await getHistory(target.chapter);
      if (!stillLive()||!readGuard(read,generation)) return;
      acceptedRead.current=read;
      const row = settled.chapter.id === target.chapter ? settled.versions.find(item => item.id === target.id && item.chapter_id === target.chapter && item.l_seq === target.cut) : undefined;
      snapshot = row ? savedSnapshot(row) : null;
      settledMetadata=row?.snapshot_lifecycle;
      if(row&&row.snapshot_lifecycle!==undefined)setHistory(settled);
      confirmedIneligible = !!row && row.can_name_snapshot === false;
    } catch { /* Keep the original write failure. */ }
    if (!stillLive()) return;
    if (snapshot) {
      mergeSnapshot(snapshot,settledMetadata);
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
  const busyLabel=labelUI.phase==="mutating"||labelUI.phase==="checking";
  const lifecycleInert=labelUI.phase!=="idle"||naming!==null||restore!==null;
  function labelButton(part:string,label:string,inert:boolean,onClick:()=>void) {
    return <button type="button" className="ax-button ax-button--quiet ax-history__snapshot-action ax-history__lifecycle-action" data-part={part} aria-disabled={inert||undefined} onClick={()=>{if(!inert)onClick();}}><span className="ax-history__snapshot-action-label">{label}</span></button>;
  }
  const visible = list.state === "ready" ? list.history.versions.filter(item => filter === "all" || !!savedSnapshot(item)) : [];
  const newest = list.state === "ready" ? list.history.versions[0] : undefined;
  const targetEligible = list.state === "ready" && naming && list.history.versions.some(row =>
    row.id === naming.id && row.l_seq === naming.cut && eligible(row));
  function nameAction(item: HistoryItem) {
    return <button type="button" data-part="snapshot-name-action" data-target-version={item.id}
      className="ax-button ax-button--quiet ax-history__snapshot-action"
      aria-label={copy["history.snapshot.actionLabel"](item.version_no)} aria-disabled={busyLabel || restore!==null || busyNaming || naming?.phase === "settled" || undefined}
      onClick={event => openNaming(item, event.currentTarget)}><span>{copy["history.snapshot.action"]}</span></button>;
  }
  return (
    <section ref={root} className="ax-history" data-surface="history" data-state={list.state} data-snapshot-lifecycle={labelUI.phase} tabIndex={-1}>
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
        {restore && restore.state !== "restoring" && <>
          {!result && <p className="ax-history__note ax-history__result" role="status">
            {copy[restore.state === "checking" ? "history.restoreChecking" : "history.restoreUnconfirmed"]}
          </p>}
          <button type="button" className="ax-button ax-button--secondary ax-history__retry"
            data-part="restore-check-again" aria-disabled={restore.state === "checking"}
            onClick={() => { if (operation.current?.state === "unconfirmed") void checkRestore(operation.current.attempt); }}>
            {copy["draft.checkAgain"]}
          </button>
        </>}
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
        <div className="ax-history__snapshot-lifecycle">
          <p className="ax-history__note ax-history__result" data-part="snapshot-lifecycle-status" role="status" aria-live="polite" aria-atomic="true">{labelUI.status}</p>
          {labelUI.phase==="checking"&&<span className="ax-history__snapshot-check-rule" aria-hidden="true"/>}
          {labelUI.failure&&<p className="ax-history__note ax-history__result" data-part="snapshot-lifecycle-failure" role="alert">{labelUI.failure}</p>}
          {labelUI.undo&&labelButton("snapshot-remove-undo",copy["history.snapshotLifecycle.undo"],lifecycleInert,undoLabel)}
          {(labelUI.phase==="unconfirmed"||(labelUI.phase==="checking"&&manualCheck.current))&&labelButton("snapshot-lifecycle-check",copy["history.snapshotLifecycle.check"],labelUI.phase==="checking",checkLabel)}
        </div>
        {visible.length === 0
          ? filter === "named" ? <div className="ax-history__snapshot-empty-group">
              <p className="ax-history__snapshot-empty" data-part="snapshot-empty">{copy["history.snapshot.empty"]}</p>
              {newest && eligible(newest) && nameAction(newest)}
            </div> : <p className="ax-history__empty" data-part="empty">{copy["history.empty"]}</p>
          : <ul className="ax-history__list" data-part="version-list">
            {visible.map((item) => {
              const index = list.history.versions.findIndex(row => row.id === item.id);
              const selected = selection?.id === item.id ? selection : null;
              const restoring = restore?.state === "restoring" && restore.attempt.id === item.id;
              return <VersionEntry key={item.id} item={item}
                timeZone={timeZone} inBook={item.id === list.history.active_version_id}
                selection={selected} namingAction={eligible(item) ? nameAction(item) : undefined} onOpen={toggleVersion} onRetry={(id) => { void readVersion(id); }}
                actions={(index !== 0 || (savedSnapshot(item)&&usableMarker(item))) && selected?.state === "ready" &&
                  <div className="ax-history__actions" data-part="version-actions" data-state={restoring ? "restoring" : "idle"}>
                    {index!==0&&<><button type="button" className="ax-button ax-button--quiet ax-history__restore" data-part="version-restore"
                      aria-disabled={locked || restore !== null || busyLabel || busyNaming ? true : undefined}
                      onClick={() => { void pressRestore(item); }}>
                      {copy[restoring ? "history.restoring" : "history.restore"]}
                    </button>
                    {locked && <p className="ax-history__note" data-part="restore-blocked" role="status">{copy["history.restoreBlocked"]}</p>}</>}
                    {savedSnapshot(item)&&usableMarker(item)&&labelButton("snapshot-remove",copy["history.snapshotLifecycle.remove"],lifecycleInert,()=>removeLabel(item))}
                  </div>} />;
            })}
          </ul>}
      </>}
    </section>
  );
}
