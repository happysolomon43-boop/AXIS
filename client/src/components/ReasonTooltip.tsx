import "./reason-tooltip.css";
import { useLayoutEffect, useRef, type RefObject, type ReactElement } from "react";
import { createPortal } from "react-dom";

type Props = { anchor: RefObject<HTMLElement>; active: boolean; reason: string; descriptionId: string };

export function ReasonTooltip({ anchor, active, reason, descriptionId }: Props): ReactElement | null {
  const tipRef = useRef<HTMLDivElement>(null);
  const reposition = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const el = anchor.current, tip = tipRef.current;
    if (!active || !el || !tip) return;
    let dwell: number | undefined, grace: number | undefined;
    let triggerHover = false, tipHover = false, focused = document.activeElement === el;
    let touch: number | null = null, held = false;
    let dismissed = false;
    const token = (name: string, fallback: number) => {
      const value = parseFloat(getComputedStyle(el).getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const cancelDwell = () => { window.clearTimeout(dwell); dwell = undefined; };
    const cancelGrace = () => { window.clearTimeout(grace); grace = undefined; };
    function dismiss() {
      cancelDwell(); cancelGrace(); touch = null; held = false; dismissed = true;
      tip!.hidden = true;
    }
    function place() {
      const v = window.visualViewport;
      const left = v?.offsetLeft ?? 0, top = v?.offsetTop ?? 0;
      const width = v?.width ?? document.documentElement.clientWidth ?? window.innerWidth;
      const height = v?.height ?? document.documentElement.clientHeight ?? window.innerHeight;
      const right = left + (width || window.innerWidth), bottom = top + (height || window.innerHeight);
      const r = el!.getBoundingClientRect();
      if (!el!.isConnected || r.right < left || r.left >= right || r.bottom < top || r.top >= bottom) {
        dismiss(); return;
      }
      if (tip!.hidden) return;
      const inset = token("--ax-space-3", 8);
      const maxWidth = Math.max(0, right-left-2*inset), maxHeight = Math.max(0, bottom-top-2*inset);
      tip!.style.maxInlineSize = Math.min(260, maxWidth) + "px";
      tip!.style.maxBlockSize = maxHeight + "px";
      const direction = getComputedStyle(el!).direction;
      tip!.style.direction = direction;
      const leaf = el!.closest(".ax-draft")?.querySelector(".ax-leaf");
      const paper = leaf && getComputedStyle(leaf).getPropertyValue("--ax-page-paper").trim();
      if (paper) tip!.style.setProperty("--ax-tooltip-paper", paper);
      const box = tip!.getBoundingClientRect();
      const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
      const x = clamp((r.left+r.right-box.width)/2, left+inset, right-inset-box.width);
      const above = r.top-inset-box.height;
      const y = clamp(above >= top+inset ? above : r.bottom+inset, top+inset, bottom-inset-box.height);
      tip!.style.insetInlineStart = (direction === "rtl" ? (document.documentElement.clientWidth || window.innerWidth)-x-box.width : x) + "px";
      tip!.style.insetBlockStart = y + "px";
    }
    function show() {
      cancelDwell(); cancelGrace();
      if (dismissed) return;
      tip!.hidden = false;
      place();
    }
    function startDwell() {
      cancelDwell(); cancelGrace();
      dwell = window.setTimeout(() => {
        dwell = undefined;
        if (touch !== null) held = true;
        show();
      }, token("--ax-dwell-tooltip", 500));
    }
    function maybeLeave() {
      if (held || focused || triggerHover || tipHover) return;
      cancelDwell(); cancelGrace();
      grace = window.setTimeout(() => { grace = undefined; if (!held && !focused && !triggerHover && !tipHover) tip!.hidden = true; },
        token("--ax-dur-hover", 120));
    }
    const coarse = (e: PointerEvent) => e.pointerType === "touch" || e.pointerType === "pen" ||
      (e.pointerType !== "mouse" && window.matchMedia?.("(pointer: coarse)").matches);
    function enter(e: PointerEvent) {
      if (coarse(e)) return;
      triggerHover = true; dismissed = false; cancelGrace();
      if (tip!.hidden) startDwell();
    }
    function leave(e: PointerEvent) {
      triggerHover = false;
      if (touch === e.pointerId && !held) { touch = null; cancelDwell(); }
      if (!coarse(e)) maybeLeave();
    }
    function focus() {
      focused = true;
      // A touch-generated focus does not bypass the long-press intent delay.
      if (touch !== null) return;
      dismissed = false; show();
    }
    function blur() { focused = false; dismiss(); }
    function down(e: PointerEvent) {
      if (!coarse(e) || e.button !== 0) return;
      touch = e.pointerId; held = false; dismissed = false;
      tip!.hidden = true;
      startDwell();
    }
    function move(e: PointerEvent) {
      if (touch !== e.pointerId || held) return;
      const r = el!.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        touch = null; cancelDwell();
      }
    }
    function up(e: PointerEvent) {
      if (touch !== e.pointerId) return;
      touch = null;
      if (!held) cancelDwell();
    }
    function outside(e: PointerEvent) {
      if (e.target instanceof Node && !el!.contains(e.target) && !tip!.contains(e.target)) dismiss();
    }
    function escape(e: KeyboardEvent) { if (e.key === "Escape") dismiss(); }
    function tipEnter() { tipHover = true; cancelGrace(); }
    function tipLeave() { tipHover = false; maybeLeave(); }
    el.addEventListener("pointerenter", enter); el.addEventListener("pointerleave", leave);
    el.addEventListener("focus", focus); el.addEventListener("blur", blur);
    el.addEventListener("pointerdown", down);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true); document.addEventListener("pointercancel", up, true);
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true);
    tip.addEventListener("pointerenter", tipEnter); tip.addEventListener("pointerleave", tipLeave);
    window.addEventListener("blur", dismiss); window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place); window.visualViewport?.addEventListener("scroll", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(el); observer?.observe(tip);
    const removal = new MutationObserver(() => { if (!el.isConnected) dismiss(); });
    removal.observe(document.body, { childList: true, subtree: true });
    reposition.current = place;
    if (focused) show(); else place();
    return () => {
      dismiss(); observer?.disconnect(); removal.disconnect(); reposition.current = () => {};
      el.removeEventListener("pointerenter", enter); el.removeEventListener("pointerleave", leave);
      el.removeEventListener("focus", focus); el.removeEventListener("blur", blur); el.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true);
      tip.removeEventListener("pointerenter", tipEnter); tip.removeEventListener("pointerleave", tipLeave);
      window.removeEventListener("blur", dismiss); window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchor, active, descriptionId]);
  useLayoutEffect(() => reposition.current(), [reason]);
  return active ? createPortal(<div ref={tipRef} role="tooltip" id={descriptionId} className="ax-tooltip" hidden>{reason}</div>, document.body) : null;
}
