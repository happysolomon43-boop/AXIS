import { useCallback, useEffect, useRef, useState } from "react";
import { getSeries, listSeries } from "./api/endpoints";
import { ApiError } from "./api/http";
import type { BookRow, SeriesRow, SeriesTree } from "./api/types";
import { copy } from "./copy";
import { getLastSeriesId, setLastSeriesId } from "./device";
import { Onboarding } from "./onboarding/Onboarding";
import { Shell } from "./shell/Shell";
import "./styles/opening.css";

type Failure = "opening.identity" | "opening.notFound" | "opening.failed";
type OpeningState =
  | { state: "opening" | "retrying" | "onboarding" }
  | { state: "failed"; failure: Failure }
  | { state: "ready"; tree: SeriesTree; focusBinder: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => Object.hasOwn(value, key) && typeof value[key] === "string");
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function validSeries(value: unknown): value is SeriesRow {
  return record(value) && strings(value, ["id", "owner_id", "title"])
    && Object.hasOwn(value, "genre_rubric_id") && nullableString(value.genre_rubric_id)
    && Object.hasOwn(value, "foundation") && record(value.foundation);
}
function validBook(value: unknown, id: string): value is BookRow {
  return record(value) && strings(value, ["id", "series_id", "title", "status", "author_id", "language"])
    && value.series_id === id && ["planned", "drafting", "complete", "released"].includes(value.status as string)
    && Object.hasOwn(value, "ordinal") && typeof value.ordinal === "number" && Number.isInteger(value.ordinal)
    && Object.hasOwn(value, "label") && nullableString(value.label);
}
function validTree(value: unknown, id: string): value is SeriesTree {
  return record(value) && validSeries(value.series) && value.series.id === id
    && Array.isArray(value.books) && value.books.every(book => validBook(book, id));
}
function failureCopy(error: unknown, detail: boolean): Failure {
  if (error instanceof ApiError) {
    if (error.status === 401 && error.code === "auth_required") return "opening.identity";
    if (detail && error.status === 404 && error.code === "not_found") return "opening.notFound";
  }
  return "opening.failed";
}

export function App() {
  const [view, setView] = useState<OpeningState>({ state: "opening" });
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const binderFocused = useRef(false);

  const open = useCallback(async (existing?: SeriesRow[], retry = false) => {
    if (!mounted.current || pending.current) return;
    const attempt = ++generation.current;
    const current = () => mounted.current && generation.current === attempt;
    pending.current = true;
    setView({ state: retry ? "retrying" : "opening" });
    let detail = false;
    try {
      const series = existing ?? await listSeries(200);
      if (!current()) return;
      if (!Array.isArray(series) || !series.every(validSeries)) throw new ApiError(200, "unreadable");
      if (!series.length) {
        setView({ state: "onboarding" });
        return;
      }
      const remembered = getLastSeriesId();
      const { id } = series.find(row => row.id === remembered) ?? series[0];
      detail = true;
      const tree = await getSeries(id, 200);
      if (!current()) return;
      if (!validTree(tree, id)) throw new ApiError(200, "unreadable");
      setLastSeriesId(id);
      setView({ state: "ready", tree, focusBinder: retry });
    } catch (error) {
      if (current()) setView({ state: "failed", failure: failureCopy(error, detail) });
    } finally {
      if (current()) pending.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void open();
    return () => {
      mounted.current = false;
      ++generation.current;
      pending.current = false;
    };
  }, [open]);

  useEffect(() => {
    if (view.state === "ready" && view.focusBinder && !binderFocused.current) {
      binderFocused.current = true;
      document.querySelector<HTMLButtonElement>('[data-surface="shell"] [data-part="binder-door"]')?.focus();
    }
  }, [view]);

  if (view.state === "ready") return <Shell tree={view.tree} />;
  if (view.state === "onboarding") {
    return <Onboarding onStarted={tree => {
      if (mounted.current) {
        setLastSeriesId(tree.series.id);
        setView({ state: "ready", tree, focusBinder: false });
      }
    }} onExisting={series => { void open(series); }} />;
  }

  const failed = view.state === "failed";
  const retrying = view.state === "retrying";
  return (
    <section className="ax-opening" data-surface={failed || retrying ? "opening-failed" : "opening"} data-state={view.state}>
      {failed
        ? <p key="failure" className="ax-opening__failure" data-part="failure" role="alert">{copy[view.failure]}</p>
        : <p key="status" className="ax-opening__status" data-part="status" role="status">{copy["opening.status"]}</p>}
      {!failed && <div key="rule" className="ax-reading-rule ax-opening__rule" data-part="rule" aria-hidden="true" />}
      {(failed || retrying) && <button key="try-again" className="ax-button ax-button--secondary ax-opening__retry"
        data-part="try-again" type="button" aria-disabled={retrying || undefined}
        onClick={() => { if (!pending.current) void open(undefined, true); }}>{copy["opening.retry"]}</button>}
    </section>
  );
}
