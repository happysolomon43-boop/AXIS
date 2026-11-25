import "./binder.css";
import { useEffect, useRef } from "react";
import type { SeriesTree } from "../api/types";
import { BookGroup } from "./BookGroup";

export function Binder({ tree }: { tree: SeriesTree }) {
  const refreshers = useRef(new Set<() => void>()).current;

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
        {tree.books.map((book, index) => (
          <BookGroup key={book.id} book={book} initiallyExpanded={index === 0} refreshers={refreshers} />
        ))}
      </ul>
    </div>
  );
}
