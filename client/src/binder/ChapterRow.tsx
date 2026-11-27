import "./open.css";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { copy } from "../copy";
import type { ChapterListItem } from "../api/types";
import { OverflowGlyph } from "../glyphs";
import { chapterRowName, formatWordCount, syncChip } from "./format";

export function canPullBack(item: ChapterListItem): boolean {
  return item.active_version_id !== null && (item.sync?.state === "in_book" || item.sync?.state === "edited");
}

export function ChapterRow({ item, position, current = false, locked = false, onOpen, onPullBack, pendingPullBack,
  selected = false, menuOpen = false, released = false, onSelect, onMenu, onDismiss, onMove }: {
  item: ChapterListItem; position: number; current?: boolean; locked?: boolean; onOpen?: () => void;
  onPullBack?: () => void; pendingPullBack?: string | null; selected?: boolean; menuOpen?: boolean; released?: boolean;
  onSelect?: () => void; onMenu?: () => void; onDismiss?: () => void; onMove?: (direction: number) => void;
}) {
  const chip = syncChip(item);
  const name = chapterRowName(position, item.title);
  const menuLabel = copy["binder.menuPrefix"] + name;
  const eligible = !released && canPullBack(item);
  const pullBackInert = locked || Boolean(pendingPullBack);
  const row = useRef<HTMLLIElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [roving, setRoving] = useState(0);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    setRoving(0);
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);
  useLayoutEffect(() => {
    if (!menuOpen || eligible || roving === 0) return;
    setRoving(0);
    if (document.activeElement === document.body) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [eligible, menuOpen, roving]);

  function openMenu() {
    onSelect?.();
    if (!menuOpen) onMenu?.();
  }
  function navigate() {
    onSelect?.();
    if (locked || current) return;
    onDismiss?.();
    onOpen?.();
  }
  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "Tab")) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); onDismiss?.(); opener.current?.focus();
    } else if (event.key === "Tab") {
      // Resume ordinary tab order relative to the trigger, skipping the transient menu.
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex], [contenteditable="true"]'))
        .filter(el => el.tabIndex >= 0 && !el.matches(":disabled") && !el.closest("[hidden]") && !el.closest('[data-part="chapter-menu"]'));
      const i = controls.indexOf(trigger.current!);
      const next = controls[i + (event.shiftKey ? -1 : 1)];
      onDismiss?.();
      if (next) { event.preventDefault(); next.focus(); }
      else trigger.current?.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[target]?.focus();
    }
  }
  return (
    <li ref={row} className="ax-binder-chapter ax-binder__selectable" data-part="chapter" data-chapter-id={item.id}
      data-selected={selected ? "true" : "false"} aria-label={name}
      onContextMenu={event => { event.preventDefault(); openMenu(); }}
      onClick={event => { if (event.button === 0 && !(event.target as Element).closest("button,[role=menu]")) navigate(); }}>
      {selected && <span className="ax-binder__selected-rule" data-part="selected-rule" aria-hidden="true" />}
      <span className="ax-binder-numeral" data-part="numeral">{position}</span>
      {item.title !== null && (
        <span className="ax-binder-chapter-title" data-part="title" title={item.title}>{item.title}</span>
      )}
      <span className="ax-binder-count" data-part="count">{formatWordCount(item.word_count)}</span>
      {chip !== null && <span className="ax-binder-chip ax-binder__sync" data-part="chip">{chip}</span>}
      <button ref={trigger} className="ax-button ax-button--quiet ax-binder__menu-trigger" type="button"
        data-part="chapter-menu-trigger" aria-label={menuLabel} aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={openMenu}><OverflowGlyph /></button>
      {menuOpen && <div ref={menu} className="ax-binder__menu" data-part="chapter-menu" role="menu" aria-label={menuLabel}
        onKeyDown={menuKey}>
        <button type="button" className="ax-binder__menu-item" role="menuitem" tabIndex={roving === 0 ? 0 : -1}
          aria-disabled={current || locked || undefined} onFocus={() => setRoving(0)} onClick={navigate}>{copy["binder.menuOpen"]}</button>
        {eligible && <button type="button" className="ax-binder__menu-item" role="menuitem" tabIndex={roving === 1 ? 0 : -1}
          aria-disabled={pullBackInert || undefined} onFocus={() => setRoving(1)}
          onClick={() => { if (!pullBackInert) onPullBack?.(); }}>{copy["binder.menuPullBack"]}</button>}
      </div>}
      {eligible && (
        <button className="ax-button ax-button--quiet ax-binder__pullback" type="button" data-part="chapter-pull-back"
          aria-label={copy["binder.pullBackPrefix"] + " " + name}
          aria-disabled={pullBackInert || undefined} onClick={() => { if (!pullBackInert) onPullBack?.(); }}>
          {pendingPullBack === item.id ? copy["binder.pullingBack"] : copy["binder.pullBack"]}
        </button>
      )}
      <button ref={opener} type="button" data-part="chapter-open" aria-label={copy["binder.openPrefix"] + " " + name}
        data-selected={selected ? "true" : "false"} aria-current={current ? "true" : undefined} aria-disabled={locked}
        onFocus={onSelect} onClick={navigate}
        onKeyDown={event => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          if ((!event.shiftKey && event.key === "ContextMenu") || (event.shiftKey && event.key === "F10")) {
            event.preventDefault(); event.stopPropagation(); openMenu();
          } else if (!event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault(); event.stopPropagation(); onMove?.(event.key === "ArrowUp" ? -1 : 1);
          }
        }}>
        {current && <span data-part="current-mark" aria-hidden="true" />}
      </button>
    </li>
  );
}
