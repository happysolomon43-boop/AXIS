import "./binder.css";
import "../styles/binder-sync.css";
import "./sync-layout.css";
import "../styles/binder-menu.css";
import "../styles/binder-pullback-check.css";
import { useEffect, useRef } from "react";
import type { SeriesTree } from "../api/types";
import { BookGroup, PullBackContext, usePullBackController } from "./BookGroup";

export function Binder({ tree, openChapterId = null, locked = false, onOpenChapter, onChapterPullBackLanded = () => {}, refreshToken = 0 }: {
  tree: SeriesTree; openChapterId?: string | null; locked?: boolean;
  onOpenChapter?: (chapterId: string) => void; onChapterPullBackLanded?: (chapterId: string) => void; refreshToken?: number;
}) {
  const refreshers = useRef(new Set<() => void>()).current;
  const pullBack = usePullBackController();

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refreshers.forEach((refresh) => refresh());
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshers]);

  return (
    <div className="ax-binder" data-surface="binder">
      <p className="ax-binder-title" data-part="series-title">{tree.series.title}</p>
      <ul className="ax-binder-books" data-part="books">
        <PullBackContext.Provider value={pullBack}>
          {tree.books.map((book, index) => (
            <BookGroup key={book.id} book={book} initiallyExpanded={index === 0} refreshers={refreshers}
              openChapterId={openChapterId} locked={locked} onOpenChapter={onOpenChapter} onChapterPullBackLanded={onChapterPullBackLanded} refreshToken={refreshToken} />
          ))}
        </PullBackContext.Provider>
      </ul>
    </div>
  );
}
