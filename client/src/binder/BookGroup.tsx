import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createChapter, listBookChapters, pullBackChapter } from "../api/endpoints";
import { ApiError } from "../api/http";
import type { BookRow, ChapterListItem } from "../api/types";
import { copy } from "../copy";
import { AxisMotif, ChevronGlyph } from "../glyphs";
import { canPullBack, ChapterRow } from "./ChapterRow";

type ChapterList = { state: "loading" | "failed" } | { state: "ready"; items: ChapterListItem[] };
type GroupState = { list: ChapterList; expanded: boolean; adding: boolean; addFailed: boolean; selectedId: string | null };
type Props = {
  book: BookRow; initiallyExpanded: boolean; refreshers: Set<() => void>;
  openChapterId?: string | null; locked?: boolean; onOpenChapter?: (chapterId: string) => void;
  onChapterPullBackLanded?: (chapterId: string) => void; refreshToken?: number;
};
type Target = { bookId: string; chapterId: string };
type Attempt = Target & { active: string; phase: "posting" | "refreshing" | "settling" | "unsettled" | "checking"; uncertain: boolean;
  epoch: number; initialOpen: string | null; focusRow: boolean; navigated?: boolean };
type Failure = { bookId: string; message: string };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function id(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp("^" + prefix + "_[0-9a-f]{12}$").test(value);
}
function validList(items: unknown, bookId: string): items is ChapterListItem[] {
  const ids = new Set<string>();
  return Array.isArray(items) && items.every(item => {
    if (!record(item) || !id(item.id,"ch") || ids.has(item.id) || item.book_id !== bookId ||
        typeof item.order_key !== "string" || !/^[0-9]{10}$/.test(item.order_key) ||
        !(item.title === null || typeof item.title === "string") || typeof item.word_count !== "number" ||
        !Number.isInteger(item.word_count) || item.word_count < 0 ||
        !(item.version_id === null || id(item.version_id,"ver")) ||
        !(item.active_version_id === null || id(item.active_version_id,"ver"))) return false;
    ids.add(item.id);
    if (item.sync === undefined) return true;
    const sync = item.sync;
    return record(sync) && typeof sync.same === "boolean" &&
      ((sync.state === "draft_only" && !sync.same) || (sync.state === "in_book" && sync.same) ||
      (sync.state === "edited" && !sync.same) || sync.state === "being_revised");
  });
}
function refusal(error: unknown): { uncertain: boolean; message: string } {
  let message: string = copy["binder.pullBackFailed"];
  if (!(error instanceof ApiError)) return {uncertain:true,message};
  const definite = (error.status === 400 && error.code === "validation_failed") ||
    (error.status === 401 && error.code === "auth_required") || (error.status === 404 && error.code === "not_found") ||
    (error.status === 409 && (error.code === "not_in_book" || error.code === "pull_back_conflict")) ||
    (error.status === 413 && error.code === "payload_too_large") || (error.status === 415 && error.code === "unsupported_media_type");
  if (error.status === 409 && error.code === "pull_back_conflict" && record(error.details)) {
    if (error.details.reason === "base_choice_required") message = copy["binder.pullBackDivergent"];
    if (error.details.reason === "released_book") message = copy["binder.pullBackReleased"];
    if (error.details.reason === "active_changed") message = copy["binder.pullBackChanged"];
  }
  return {uncertain: !definite,message};
}

export function usePullBackController() {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [menuTarget, setMenuTarget] = useState<Target | null>(null);
  const pending = useRef<Attempt | null>(null);
  const menu = useRef<Target | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; menu.current = null; epoch.current++; };
  }, []);
  const closeMenu = useCallback(() => { menu.current = null; if (mounted.current) setMenuTarget(null); }, []);
  useEffect(() => {
    function dismiss(event: PointerEvent) {
      const target = menu.current;
      const element = event.target;
      if (!target || !(element instanceof Element)) return;
      const row = element.closest('[data-part="chapter"]');
      if (row?.getAttribute("data-chapter-id") === target.chapterId && element.closest('[data-part="chapter-menu"],[data-part="chapter-menu-trigger"]')) return;
      closeMenu();
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [closeMenu]);
  function change(a: Attempt | null) { pending.current = a; if (mounted.current) setAttempt(a ? {...a} : null); }
  return {
    attempt, pending, failure, setFailure, menuTarget, menu, epoch, mounted,
    openMenu(target: Target) {
      if (menu.current?.bookId === target.bookId && menu.current.chapterId === target.chapterId) return;
      epoch.current++;
      menu.current = target; setMenuTarget(target);
    },
    closeMenu,
    begin(a: Attempt) { if (!mounted.current || pending.current) return false; setFailure(null); change(a); return true; },
    change,
    end(a: Attempt) { if (pending.current === a) change(null); },
  };
}
export const PullBackContext = createContext<ReturnType<typeof usePullBackController> | null>(null);

export function BookGroup({ book, initiallyExpanded, refreshers, openChapterId = null, locked = false, onOpenChapter, onChapterPullBackLanded = () => {}, refreshToken = 0 }: Props) {
  const localPullBack = usePullBackController();
  const pullBack = useContext(PullBackContext) ?? localPullBack;
  const controller = useRef(pullBack); controller.current = pullBack;
  const [view, setView] = useState<GroupState>({list:{state:"loading"}, expanded:initiallyExpanded, adding:false, addFailed:false, selectedId:null});
  const current = useRef(view);
  const latestRead = useRef(0);
  const mounted = useRef(false);
  const previousToken = useRef(refreshToken);
  const pendingRefresh = useRef(false);
  const actions = useRef({locked,onOpenChapter,openChapterId,onChapterPullBackLanded,status:book.status});
  if (actions.current.openChapterId !== openChapterId) pullBack.epoch.current++;
  actions.current = {locked,onOpenChapter,openChapterId,onChapterPullBackLanded,status:book.status};
  const group = useRef<HTMLLIElement>(null);
  const chapterList = useRef<HTMLOListElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const focusAfterRead = useRef<{id:string|null; previous:Element|null} | null>(null);

  function rowOpen(id: string | null) {
    if (id === null) return null;
    return Array.from(chapterList.current?.querySelectorAll<HTMLButtonElement>('[data-part="chapter-open"]') ?? [])
      .find(button => button.parentElement?.dataset.chapterId === id) ?? null;
  }
  useLayoutEffect(() => {
    const target = focusAfterRead.current; focusAfterRead.current = null;
    if (!target || (document.activeElement !== document.body && document.activeElement !== target.previous)) return;
    (rowOpen(target.id) ?? toggleButton.current ?? document.querySelector<HTMLButtonElement>('[data-part="binder-door"]'))?.focus();
  });

  const update = useCallback((patch: Partial<GroupState>) => {
    current.current = { ...current.current, ...patch }; setView(current.current);
  }, []);
  function choose(chapterId: string) {
    if (current.current.expanded && current.current.list.state === "ready" && current.current.list.items.some(item => item.id === chapterId)) update({selectedId:chapterId});
  }
  function navigate(chapterId: string) {
    const a=actions.current;
    if (a.locked || a.openChapterId === chapterId || !a.onOpenChapter) return;
    controller.current.epoch.current++;
    a.onOpenChapter(chapterId);
  }

  function applyLanding(a: Attempt) {
    const ctl=controller.current;
    if (!mounted.current || !ctl.mounted.current || ctl.pending.current !== a) return;
    actions.current.onChapterPullBackLanded(a.chapterId);
    const live=actions.current;
    if (current.current.expanded && !live.locked && live.openChapterId !== a.chapterId &&
        live.openChapterId === a.initialOpen && ctl.epoch.current === a.epoch && live.onOpenChapter) { a.navigated=true; navigate(a.chapterId); }
  }

  const read = useCallback(async (blocking: boolean, write?: {failed:boolean;previousCount:number}, forAttempt?: Attempt) => {
    const number = ++latestRead.current;
    if (blocking) update({list:{state:"loading"}});
    let items: ChapterListItem[];
    try {
      const result = await listBookChapters(book.id, 200);
      if (!validList(result, book.id)) throw new Error("Unusable chapter list");
      items = result;
    } catch {
      if (!mounted.current || latestRead.current !== number || (!write && current.current.adding)) return;
      const ctl=controller.current, a=ctl.pending.current;
      if (a?.bookId === book.id && a.phase !== "posting" && a.phase !== "refreshing") {
        a.phase = "unsettled"; ctl.change(a);
      } else if (a?.bookId === book.id && a.phase === "refreshing") {
        ctl.end(a);
        // Preserve the existing blocking failure path; a verified write needs no settlement.
        update({list:{state:"failed"},adding:false,addFailed:false,selectedId:null});
      } else if (!forAttempt) {
        const focused=document.activeElement;
        if (chapterList.current?.contains(focused)) focusAfterRead.current={id:null,previous:focused};
        if (ctl.menu.current?.bookId === book.id) ctl.closeMenu();
        update({list:{state:"failed"},adding:false,addFailed:false,selectedId:null});
      }
      return;
    }
    if (!mounted.current || latestRead.current !== number || (!write && current.current.adding)) return;
    const ctl=controller.current;
    const previous=current.current;
    const nextSelected=previous.expanded ? (
      items.some(x=>x.id===previous.selectedId) ? previous.selectedId :
      items.some(x=>x.id===actions.current.openChapterId) ? actions.current.openChapterId : items[0]?.id ?? null
    ) : null;
    const focused=document.activeElement;
    const row=focused?.closest('[data-part="chapter"]');
    const rowId=row?.getAttribute("data-chapter-id");
    const focusedHere=!!(row && chapterList.current?.contains(row));
    const target=ctl.menu.current;
    if (target?.bookId===book.id && (!previous.expanded || !items.some(x=>x.id===target.chapterId))) ctl.closeMenu();
    const nextRow=items.find(x=>x.id===rowId);
    if (focusedHere && (!nextRow || (focused?.matches('[data-part="chapter-pull-back"]') && (!canPullBack(nextRow) || actions.current.status==="released")))) {
      focusAfterRead.current={id:nextRow?.id??nextSelected,previous:focused};
    }
    const old=previous.list;
    const addFailed=write ? write.failed && items.length<=write.previousCount :
      previous.addFailed && (old.state==="ready" ? items.length<=old.items.length : items.length===0);
    update({list:{state:"ready",items},adding:false,addFailed,selectedId:nextSelected});
    const a=ctl.pending.current;
    if (a?.bookId===book.id && a.phase!=="posting") {
      const check=group.current?.querySelector('[data-part="pull-back-check"]');
      const landed=a.phase!=="refreshing" && a.uncertain && items.some(x=>x.id===a.chapterId && x.active_version_id===a.active && x.sync?.state==="being_revised");
      if (landed) { ctl.setFailure(null); applyLanding(a); }
      if (a.navigated) focusAfterRead.current=null;
      else if (focused===check) focusAfterRead.current={id:items.some(x=>x.id===a.chapterId)?a.chapterId:nextSelected,previous:focused};
      ctl.end(a);
    }
  }, [book.id, update]);

  useEffect(() => {
    mounted.current=true;
    function refresh() {
      const {expanded,adding,list}=current.current;
      if (expanded && !adding && list.state!=="loading") void read(list.state!=="ready");
    }
    refreshers.add(refresh);
    if (current.current.expanded) void read(true);
    return () => {
      mounted.current=false; latestRead.current++; refreshers.delete(refresh);
      const ctl=controller.current;
      if (ctl.menu.current?.bookId===book.id) ctl.closeMenu();
      const a=ctl.pending.current;
      if (a?.bookId===book.id) ctl.end(a);
    };
  }, [book.id,read,refreshers]);

  useEffect(() => {
    if (previousToken.current===refreshToken) return;
    previousToken.current=refreshToken;
    const {expanded,adding,list}=current.current;
    if (!expanded || list.state==="loading" || (list.state==="ready" && list.items.length===0)) return;
    if (adding) {pendingRefresh.current=true;return;}
    void read(list.state!=="ready");
  }, [refreshToken,read]);

  function toggle() {
    const expanded=!current.current.expanded, ctl=controller.current;
    if (!expanded) {
      if (group.current?.querySelector('[data-part="chapters"]')?.contains(document.activeElement)) {
        toggleButton.current?.focus();
      }
      if (ctl.menu.current?.bookId===book.id) ctl.closeMenu();
      update({expanded,selectedId:null}); return;
    }
    const list=current.current.list;
    const selectedId=list.state==="ready" ? (list.items.find(x=>x.id===actions.current.openChapterId)?.id ?? list.items[0]?.id ?? null) : null;
    update({expanded,selectedId});
    if (!current.current.adding && !(ctl.pending.current?.bookId===book.id && ["unsettled","checking","settling"].includes(ctl.pending.current.phase))) {
      void read(list.state!=="ready");
    }
  }

  async function addChapter(first: boolean) {
    const {expanded,adding,list}=current.current;
    if (!expanded || adding || actions.current.locked || list.state!=="ready" || (list.items.length===0)!==first) return;
    const previousCount=list.items.length;
    latestRead.current++;
    update({adding:true,addFailed:false});
    let failed=false,created;
    try {created=await createChapter(book.id,"");} catch {failed=true;}
    if (!mounted.current) return;
    if (created) navigate(created.chapter.id);
    await read(first,{failed,previousCount});
    if (!mounted.current || !pendingRefresh.current) return;
    pendingRefresh.current=false;
    const state=current.current;
    if (state.expanded && state.list.state!=="loading") void read(state.list.state!=="ready");
  }

  async function pullBackItem(item: ChapterListItem, fromMenu: boolean) {
    const ctl=controller.current, live=actions.current, list=current.current.list;
    const actual=list.state==="ready"?list.items.find(x=>x.id===item.id):undefined;
    if (!mounted.current || !current.current.expanded || live.locked || live.status==="released" || !actual || !canPullBack(actual) || actual.active_version_id===null) return;
    const a:Attempt={bookId:book.id,chapterId:actual.id,active:actual.active_version_id,phase:"posting",uncertain:false,
      epoch:ctl.epoch.current,initialOpen:live.openChapterId,focusRow:fromMenu};
    if (!ctl.begin(a)) return;
    ctl.closeMenu();
    if (fromMenu) rowOpen(actual.id)?.focus();
    try {
      const result=await pullBackChapter(actual.id,a.active);
      if (result.chapter.book_id!==book.id) throw new ApiError(200,"unreadable");
    } catch(error) {
      if (!mounted.current || !ctl.mounted.current || ctl.pending.current!==a) return;
      const {message,uncertain}=refusal(error);
      a.uncertain=uncertain;a.phase="settling";
      ctl.setFailure({bookId:book.id,message});ctl.change(a);
      await read(false,undefined,a);
      return;
    }
    if (!mounted.current || !ctl.mounted.current || ctl.pending.current!==a) return;
    a.phase="refreshing";ctl.change(a);
    applyLanding(a);
    if (current.current.expanded) await read(false,undefined,a);
    else ctl.end(a);
  }

  function checkAgain() {
    const ctl=controller.current,a=ctl.pending.current;
    if (!mounted.current || !current.current.expanded || a?.bookId!==book.id || a.phase!=="unsettled") return;
    a.phase="checking";ctl.change(a);void read(false,undefined,a);
  }

  const {list,expanded,adding,addFailed,selectedId}=view;
  const state=list.state==="ready"&&list.items.length===0?"empty":list.state;
  const pending=pullBack.attempt;
  const unsettled=pending?.bookId===book.id&&(pending.phase==="unsettled"||pending.phase==="checking");
  const status=pullBack.failure?.bookId===book.id?pullBack.failure.message:null;
  return (
    <li ref={group} className="ax-binder-book" data-part="book" data-book-id={book.id}>
      <button ref={toggleButton} className="ax-binder-toggle" type="button" data-part="book-toggle" aria-expanded={expanded} onClick={toggle}>
        <ChevronGlyph direction={expanded?"down":"right"}/>{book.title}
      </button>
      <div data-part="chapters" data-state={state} hidden={!expanded}>
        {list.state==="loading" && <p className="ax-status ax-binder-status" role="status" data-part="reading">
          {copy["binder.reading"]}<span data-part="reading-rule" className="ax-reading-rule" aria-hidden="true"/>
        </p>}
        {list.state==="failed" && <div className="ax-status ax-binder-status" role="alert" data-part="read-failure">
          <div>{copy["binder.readFailed"]}</div>
          <button className="ax-button ax-button--secondary" type="button" data-part="try-again" onClick={()=>{if(current.current.list.state==="failed")void read(true);}}>{copy["binder.tryAgain"]}</button>
        </div>}
        {state==="empty" && <div data-part="empty" className="ax-binder-empty">
          <AxisMotif/>
          <button className="ax-button ax-button--secondary ax-button--wide" type="button" data-part="add-first-scene" aria-disabled={adding||locked||undefined} onClick={()=>{void addChapter(true);}}>
            {adding?copy["binder.adding"]:copy["binder.addFirstScene"]}
          </button>
          {addFailed&&<p className="ax-status ax-binder-status" role="alert" data-part="add-failure">{copy["binder.addFailed"]}</p>}
        </div>}
        {list.state==="ready"&&state!=="empty"&&<ol ref={chapterList} className="ax-binder-chapter-list" data-part="chapter-list">
          {list.items.map((item,index)=><ChapterRow key={item.id} item={item} position={index+1} current={item.id===openChapterId}
            selected={selectedId===item.id} menuOpen={pullBack.menuTarget?.bookId===book.id&&pullBack.menuTarget.chapterId===item.id}
            released={book.status==="released"} locked={locked} onSelect={()=>choose(item.id)}
            onMenu={()=>pullBack.openMenu({bookId:book.id,chapterId:item.id})} onDismiss={pullBack.closeMenu}
            onMove={direction=>rowOpen(list.items[index+direction]?.id??item.id)?.focus()}
            onOpen={()=>navigate(item.id)} onPullBack={fromMenu=>{void pullBackItem(item,fromMenu);}}
            pendingPullBack={pending?.chapterId??null}/>)}
        </ol>}
        {expanded&&status!==null&&<p className={"ax-binder__pullback-failure"+(unsettled?" ax-binder__pullback-failure--unsettled":"")} data-part="pull-back-failure" role="status">{status}</p>}
        {expanded&&unsettled&&<button className="ax-button ax-button--quiet ax-binder__pullback-check" data-part="pull-back-check" type="button" aria-disabled={pending?.phase==="checking"||undefined} onClick={checkAgain}>{copy["binder.pullBackCheck"]}</button>}
        {state==="ready"&&<>
          <button type="button" data-part="add-chapter" className="ax-button ax-button--secondary" aria-disabled={adding||locked} onClick={()=>{void addChapter(false);}}>
            {adding?copy["binder.adding"]:copy["binder.addChapter"]}
          </button>
          {addFailed&&<p role="alert" data-part="add-failure">{copy["binder.addChapterFailed"]}</p>}
        </>}
      </div>
    </li>
  );
}
