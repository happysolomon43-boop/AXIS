import { useCallback, useEffect, useRef, useState } from "react";
import { getSeries, listSeries } from "./api/endpoints";
import type { SeriesRow, SeriesTree } from "./api/types";
import { copy } from "./copy";
import { getLastSeriesId, setLastSeriesId } from "./device";
import { Onboarding } from "./onboarding/Onboarding";
import { Shell } from "./shell/Shell";

type OpeningState =
  | { state: "loading" | "failed" | "onboarding" }
  | { state: "ready"; tree: SeriesTree };

export function App() {
  const [view, setView] = useState<OpeningState>({ state: "loading" });
  const mounted = useRef(false);
  const opening = useRef(false);

  const open = useCallback(async (existing?: SeriesRow[]) => {
    if (!mounted.current || opening.current) return;
    opening.current = true;
    setView({ state: "loading" });

    try {
      const series = existing ?? await listSeries();
      if (!mounted.current) return;

      if (series.length === 0) {
        setView({ state: "onboarding" });
        return;
      }

      const remembered = getLastSeriesId();
      const { id } = series.find((row) => row.id === remembered) ?? series[0];
      const tree = await getSeries(id);
      if (mounted.current) {
        setLastSeriesId(id);
        setView({ state: "ready", tree });
      }
    } catch {
      if (mounted.current) setView({ state: "failed" });
    } finally {
      opening.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void open();
    return () => { mounted.current = false; };
  }, [open]);

  if (view.state === "ready") return <Shell tree={view.tree} />;

  if (view.state === "onboarding") {
    return (
      <Onboarding
        onStarted={(tree) => {
          if (mounted.current) {
            setLastSeriesId(tree.series.id);
            setView({ state: "ready", tree });
          }
        }}
        onExisting={open}
      />
    );
  }

  if (view.state === "failed") {
    return (
      <div className="ax-opening" role="alert" data-surface="opening-failed">
        {copy["app.openFailed"]}
        <button className="ax-button ax-button--secondary" type="button" data-part="try-again"
          onClick={() => { void open(); }}>
          {copy["app.tryAgain"]}
        </button>
      </div>
    );
  }

  return <p className="ax-status ax-opening" role="status" data-surface="opening">{copy["app.opening"]}</p>;
}
