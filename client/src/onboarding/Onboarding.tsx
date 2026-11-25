import "./onboarding.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createSeries, listSeries } from "../api/endpoints";
import type { SeriesRow, SeriesTree } from "../api/types";
import { copy } from "../copy";
import { AxisMotif } from "../glyphs";

type Props = {
  onStarted: (tree: SeriesTree) => void;
  onExisting: (series: SeriesRow[]) => void;
};

type FormState = "idle" | "creating" | "checking" | "check-failed";

function titleState(raw: string) {
  const whitespace = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
  const value = raw.replace(new RegExp(`^${whitespace.source}+|${whitespace.source}+$`, "g"), "");
  const length = [...value].length;
  if (raw.includes("\u0000")) return { value, state: "invalid" };
  if (length === 0) return { value, state: "empty" };
  if (length > 200) return { value, state: "too_long" };
  return { value, state: "ok" };
}

export function Onboarding({ onStarted, onExisting }: Props) {
  const [rawTitle, setRawTitle] = useState("");
  const [formState, setFormState] = useState<FormState>("idle");
  const [failed, setFailed] = useState(false);
  const phase = useRef<FormState>("idle");
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const title = titleState(rawTitle);

  useEffect(() => {
    mounted.current = true;
    input.current?.focus();
    return () => { mounted.current = false; };
  }, []);

  function transition(state: FormState) {
    phase.current = state;
    setFormState(state);
  }

  async function checkSeries() {
    transition("checking");
    setFailed(false);
    let series: SeriesRow[];
    try {
      series = await listSeries();
    } catch {
      if (mounted.current) {
        transition("check-failed");
        setFailed(true);
      }
      return;
    }

    if (!mounted.current) return;
    if (series.length > 0) {
      onExisting(series);
    } else {
      transition("idle");
      setFailed(true);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase.current !== "idle" || title.state !== "ok") return;

    transition("creating");
    setFailed(false);
    let tree: SeriesTree;
    try {
      tree = await createSeries(title.value);
    } catch {
      if (mounted.current) await checkSeries();
      return;
    }
    if (mounted.current) onStarted(tree);
  }

  const tooLong = title.state === "too_long";
  return (
    <form className="ax-onboarding" data-surface="onboarding" data-state={formState}
      aria-labelledby="onboarding-headline" onSubmit={submit}>
      <AxisMotif />
      <h1 id="onboarding-headline" data-part="headline">{copy["onboarding.headline"]}</h1>
      <div className="ax-field">
        <label className="ax-field-label" htmlFor="onboarding-title">{copy["onboarding.titleLabel"]}</label>
        <input
          className="ax-input"
          id="onboarding-title"
          type="text"
          data-part="title"
          autoComplete="off"
          ref={input}
          value={rawTitle}
          onChange={(event) => setRawTitle(event.target.value)}
          readOnly={formState === "creating" || formState === "checking"}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? "onboarding-title-message" : undefined}
        />
      </div>
      {tooLong && (
        <p id="onboarding-title-message" className="ax-field-message" data-part="title-message">
          <span data-part="message-glyph" className="ax-glyph-square" aria-hidden="true" />
          {copy["onboarding.titleTooLong"]}
        </p>
      )}
      <div data-part="actions" className="ax-onboarding-actions">
        <button className="ax-button ax-button--primary ax-button--wide" type="submit" data-part="start"
          aria-disabled={title.state !== "ok" || formState !== "idle" ? true : undefined}>
          {formState === "creating" ? copy["onboarding.starting"] : copy["onboarding.start"]}
        </button>
        {formState === "check-failed" && (
          <button className="ax-button ax-button--secondary" type="button" data-part="check-again"
            onClick={() => { if (phase.current === "check-failed") void checkSeries(); }}>
            {copy["onboarding.checkAgain"]}
          </button>
        )}
      </div>
      {formState === "checking" && (
        <p className="ax-status ax-onboarding-status" role="status" data-part="checking">
          {copy["onboarding.checking"]}
        </p>
      )}
      {failed && (
        <p className="ax-status ax-onboarding-status" role="alert" data-part="failure">
          {copy["onboarding.failed"]}
        </p>
      )}
      <p data-part="privacy" className="ax-onboarding-privacy">{copy["onboarding.privacy"]}</p>
    </form>
  );
}
