import { act } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import css from "../src/draft/autosave.css?raw";
import { reply } from "./d06.fixtures";
import { advance, contrast, draftThemeColors, edit, fakeClock, mountConflict, mountDraft, putOk } from "./draftFixtures";
import { deferred, internalError } from "./helpers";

afterEach(() => vi.useRealTimers());

test("AC1 draws the dot and line only in the specified states, between the chip and Save", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  let ui = mountDraft({ put: (_, n) => n === 0 ? pending.promise : internalError });
  await ui.loaded();

  function check(state: string, dotDrawn: boolean, text = "") {
    expect(ui.root).toHaveAttribute("data-autosave", state);
    const indicator = ui.part("autosave");
    expect(indicator).toHaveClass("ax-autosave");
    expect(indicator).toHaveAttribute("role", "status");
    expect(indicator).not.toHaveAttribute("tabindex");
    expect(indicator.textContent).toBe(text);
    expect(indicator.previousElementSibling).toBe(ui.part("version-chip"));
    expect(indicator.nextElementSibling).toBe(ui.part("snapshot"));
    expect(ui.part("snapshot").nextElementSibling).toBe(ui.part("save"));
    expect(ui.part("save").nextElementSibling).toBe(ui.part("send"));
    expect(indicator.children).toHaveLength(dotDrawn ? 1 : 0);
    if (dotDrawn) {
      expect(indicator.firstElementChild).toBe(ui.part("autosave-dot"));
      expect(indicator.firstElementChild).toHaveClass("ax-autosave__dot");
      expect(indicator.firstElementChild).toHaveAttribute("aria-hidden", "true");
    } else {
      expect(indicator).toBeEmptyDOMElement();
    }
  }

  check("idle", false);
  fakeClock();
  edit(ui.view());
  check("pending", true);
  await advance(2000);
  check("saving", true);
  await act(async () => { pending.resolve(reply(putOk(1))); });
  check("saved", false);
  expect(ui.part("editor")).toHaveFocus();
  edit(ui.view(), "?");
  await advance(5000);
  check("failed", true, "The draft could not be saved.");

  ui.unmount();
  vi.useRealTimers();
  ui = await mountConflict();
  check("stopped", true);
});

test("AC2 uses only the specified declarations and reaches the contrast floors in all three themes", () => {
  const expected = `
    .ax-autosave {
      display: inline-flex;
      align-items: center;
      gap: var(--ax-space-2);
      margin: 0;
      color: var(--ax-color-text-primary);
      font-size: var(--ax-type-small-size);
      line-height: var(--ax-type-small-lh);
      overflow-wrap: anywhere;
    }
    .ax-autosave__dot {
      flex: none;
      inline-size: 4px;
      block-size: 4px;
      border-radius: var(--ax-radius-1);
      background-color: var(--ax-color-text-tertiary);
    }
    .ax-draft[data-autosave="failed"] .ax-autosave__dot,
    .ax-draft[data-autosave="stopped"] .ax-autosave__dot {
      background-color: var(--ax-color-severity-break);
    }
  `;
  expect(css.replace(/\s+/g, " ").trim()).toBe(expected.replace(/\s+/g, " ").trim());
  expect(css).not.toMatch(/transition|animation|box-shadow|border-left|border-right|spinner/);
  expect(css.match(/severity-break/g)).toHaveLength(1);
  for (const { name, shell, ink, tertiary, breakColor } of draftThemeColors()) {
    expect(contrast(tertiary, shell), `${name} pending dot`).toBeGreaterThanOrEqual(3);
    expect(contrast(breakColor, shell), `${name} failed dot`).toBeGreaterThanOrEqual(3);
    expect(contrast(ink, shell), `${name} failure line`).toBeGreaterThanOrEqual(7);
  }
});
