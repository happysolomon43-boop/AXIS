import "../styles/compare.css";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { getStoredText } from "../api/endpoints";
import type { VersionSource } from "../api/validation";
import { formatVersionDate, sourceWord } from "./historyFormat";

export type CompareChoice = {
  id: string;
  chapter_id: string;
  version_no: number;
  source: VersionSource;
  at: string;
  l_seq: number;
};

type Props = {
  chapterId: string;
  versions: readonly CompareChoice[];
  a: string;
  b: string | null;
  timeZone?: string;
};
type Pair = { a: string; b: string };
type Comparison = { state: "one"; a: string; b: null }
  | (Pair & ({ state: "loading" | "failed" } | { state: "ready"; textA: string; textB: string }));
type Side = "A" | "B";
type LabelledChoice = CompareChoice & { label: string };

function VersionChip({ side, choice }: { side: Side; choice: LabelledChoice }) {
  return <div role="group" data-part="version-chip" data-side={side} data-version-id={choice.id}
    className="ax-compare__chip" aria-label={`Side ${side}`}>
    <span className="ax-compare__key" aria-hidden="true">{side}</span>
    <span className="ax-compare__chip-label">{choice.label}</span>
  </div>;
}

function TextPanel({ side, choice, content }: { side: Side; choice: LabelledChoice; content: string }) {
  const emptyId = useId();
  return <div className="ax-compare__panel" data-side={side}>
    <VersionChip side={side} choice={choice} />
    <div role="region" data-part="text" tabIndex={0} className="ax-compare__text ax-page"
      aria-label={`Text ${side}`} aria-describedby={content === "" ? emptyId : undefined}>
      <div data-part="source" className="ax-compare__source">{content}</div>
    </div>
    {content === "" && <p id={emptyId} data-part="empty-note" className="ax-compare__empty">Empty version</p>}
  </div>;
}

export function ComparePage({ chapterId, versions, a, b, timeZone }: Props) {
  const [pair, setPair] = useState<Comparison>(() => b === null ? { state: "one", a, b } : { state: "loading", a, b });
  const heading = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRef(false);
  const selectA = useId();
  const selectB = useId();

  useEffect(() => {
    if (pair.state !== "loading") return;
    const { a, b } = pair;
    let active = true;
    let textA: string | undefined;
    let textB: string | undefined;

    function settle(next: Comparison) {
      if (!active) return;
      active = false;
      textA = textB = undefined;
      // The loading object identifies this attempt even through a retry of the same IDs.
      setPair(current => current === pair ? next : current);
    }

    function admit(side: Side, body: string) {
      if (!active) return;
      if (side === "A") textA = body;
      else textB = body;
      if (textA !== undefined && textB !== undefined) settle({ state: "ready", a, b, textA, textB });
    }

    const fail = () => settle({ state: "failed", a, b });
    // Start only after the effect has survived cleanup, including a development Strict Mode replay.
    queueMicrotask(() => {
      if (!active) return;
      void getStoredText(chapterId, a).then(({ content }) => admit("A", content), fail);
      void getStoredText(chapterId, b).then(({ content }) => admit("B", content), fail);
    });
    return () => {
      active = false;
      textA = textB = undefined;
    };
  }, [chapterId, pair]);

  useLayoutEffect(() => {
    if (pair.state === "loading" && retryFocus.current) {
      retryFocus.current = false;
      heading.current?.focus();
    }
  }, [pair]);

  const choices = versions.map(choice => ({
    ...choice, label: `v${choice.version_no} · ${sourceWord(choice.source)} · ${formatVersionDate(choice.at, timeZone)}`,
  }));
  const choiceA = choices.find(item => item.id === pair.a)!;
  const choiceB = choices.find(item => item.id === pair.b);

  function choose(side: Side, id: string) {
    setPair(current => {
      if (current.state === "one" || current.a === id || current.b === id || !choices.some(choice => choice.id === id)) {
        return current;
      }
      return { state: "loading", a: side === "A" ? id : current.a, b: side === "B" ? id : current.b };
    });
  }

  function swap() {
    setPair(current => {
      if (current.state === "one") return current;
      const { a, b } = current;
      return current.state === "ready"
        ? { state: "ready", a: b, b: a, textA: current.textB, textB: current.textA }
        : { state: "loading", a: b, b: a };
    });
  }

  function selector(side: Side, input: string, selected: string, other: string) {
    return <div className="ax-compare__field">
      <label className="ax-compare__label" htmlFor={input}>Version {side}</label>
      <select id={input} className="ax-compare__select" data-part={side === "A" ? "select-a" : "select-b"}
        value={selected} onChange={event => choose(side, event.currentTarget.value)}>
        {choices.filter(choice => choice.id !== other).map(choice =>
          <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
    </div>;
  }

  return <section className="ax-compare" data-surface="compare" data-state={pair.state}>
    <div className="ax-compare__column">
      <h2 ref={heading} data-part="heading" className="ax-compare__heading" tabIndex={-1}>Compare versions</h2>
      {pair.state !== "one" && <div data-part="controls" className="ax-compare__controls">
        {selector("A", selectA, pair.a, pair.b)}
        {selector("B", selectB, pair.b, pair.a)}
        <button type="button" data-part="swap" className="ax-button ax-button--secondary ax-compare__swap" onClick={swap}>Swap</button>
      </div>}
      {pair.state === "one" && <div className="ax-compare__one">
        <p data-part="one-version">One version so far</p>
        <VersionChip side="A" choice={choiceA} />
      </div>}
      {pair.state === "loading" && <div className="ax-compare__reading">
        <p role="status" data-part="status">Diffing at ledger {Math.max(choiceA.l_seq, choiceB!.l_seq)}</p>
        <div className="ax-reading-rule" aria-hidden="true" />
      </div>}
      {pair.state === "failed" && <div className="ax-compare__failure">
        <p role="alert" data-part="failure">These versions could not be opened.</p>
        <button type="button" data-part="try-again" className="ax-button ax-button--secondary ax-compare__retry"
          onClick={event => {
            retryFocus.current = document.activeElement === event.currentTarget;
            setPair({ state: "loading", a: pair.a, b: pair.b });
          }}>Try again</button>
      </div>}
    </div>
    {pair.state === "ready" && <div data-part="panels" className="ax-compare__panels">
      <TextPanel side="A" choice={choiceA} content={pair.textA} />
      <TextPanel side="B" choice={choiceB!} content={pair.textB} />
    </div>}
  </section>;
}
