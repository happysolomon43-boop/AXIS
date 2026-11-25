import "./drawer.css";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { copy } from "../copy";

type Props = { title: string; onClose: () => void; children: ReactNode };

export function Drawer({ title, onClose, children }: Props) {
  const drawer = useRef<HTMLElement>(null);
  useLayoutEffect(() => { drawer.current?.focus(); }, []);

  return (
    <aside ref={drawer} className="ax-drawer" data-region="drawer" aria-label={title} tabIndex={-1} onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }}>
      <div className="ax-drawer__header" data-part="drawer-header">
        <h2 className="ax-drawer__title" data-part="drawer-title">{title}</h2>
        <button type="button" className="ax-button ax-button--quiet ax-drawer__close" data-part="drawer-close" onClick={onClose}>{copy["drawer.close"]}</button>
      </div>
      <div className="ax-drawer__body" data-part="drawer-body">{children}</div>
    </aside>
  );
}
