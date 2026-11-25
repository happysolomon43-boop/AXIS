import "./shell.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SeriesTree } from "../api/types";
import { Binder } from "../binder/Binder";
import { copy } from "../copy";
import { AxisMark, BinderGlyph } from "../glyphs";

export function Shell({ tree }: { tree: SeriesTree }) {
  const [shown, setShown] = useState(true);
  const current = useRef(true);
  const door = useRef<HTMLButtonElement>(null);
  const binder = useRef<HTMLElement>(null);
  const binderId = useId();

  const toggleBinder = useCallback(() => {
    current.current = !current.current;
    if (!current.current && binder.current?.contains(document.activeElement)) {
      door.current?.focus();
    }
    setShown(current.current);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code === "Backslash" && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        toggleBinder();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleBinder]);

  return (
    <div className="ax-shell" data-surface="shell">
      <header className="ax-strip" data-region="top-strip">
        <span className="ax-wordmark" data-part="wordmark">
          <AxisMark />
          {copy["shell.wordmark"]}
        </span>
        <button
          className="ax-door"
          type="button"
          data-part="binder-door"
          aria-label={copy["shell.binderDoor"]}
          aria-pressed={shown}
          aria-controls={binderId}
          title={copy["shell.binderDoorHint"]}
          ref={door}
          onClick={toggleBinder}
        >
          <BinderGlyph />
          {shown && <span className="ax-door-underline" data-part="door-underline" aria-hidden="true" />}
        </button>
      </header>
      <aside className="ax-binder-region" data-region="binder" aria-label={copy["shell.binderRegion"]}
        id={binderId} ref={binder} hidden={!shown}>
        <Binder tree={tree} />
      </aside>
      <main className="ax-text-region" data-region="text" aria-label={copy["shell.textRegion"]} />
    </div>
  );
}
