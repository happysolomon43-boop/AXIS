import { act, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import css from "../src/draft/conflict.css?raw";
import { chapterPath, detailText, reply } from "./d06.fixtures";
import { contrast, draftThemeColors, mountConflict } from "./draftFixtures";
import { internalError } from "./helpers";

afterEach(() => vi.useRealTimers());

test("AC1 renders an ink banner with secondary choices, a note, and the proper head order", async () => {
  const ui = await mountConflict({
    chapter: (_, n) => n === 1 ? internalError : reply(detailText),
    writes: [{ method: "POST", path: `${chapterPath}/versions`, reply: internalError }],
  });
  const head = ui.part("draft-head");
  const banner = ui.part("conflict");
  const childParts = (element: Element) => Array.from(element.children).filter(child=>!child.classList.contains("ax-draft__snapshot-feedback")).map(child=>child.getAttribute("data-part"));
  expect(childParts(head)).toEqual(["toolbar", "status", "conflict"]);
  expect(banner).toHaveClass("ax-banner");
  expect(banner).toHaveAttribute("role", "alert");
  expect(banner.querySelector('.ax-banner__mark, [data-part="not-saved-mark"]')).toBeNull();
  expect(banner.firstElementChild).toMatchObject({ tagName: "P" });
  expect(banner.firstElementChild).toHaveClass("ax-banner__lead");
  expect(banner.firstElementChild).toHaveTextContent("This chapter changed somewhere else. Your text is not saved as a draft.");
  expect(childParts(banner)).toEqual([null, "reload-latest", "keep-mine", "conflict-copy"]);
  for (const name of ["reload-latest", "keep-mine", "conflict-copy"]) {
    const button = ui.part(name);
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveClass("ax-button", "ax-button--secondary");
    expect(button).not.toHaveClass("ax-button--primary");
  }

  await act(async () => { fireEvent.click(ui.part("reload-latest")); });
  const note = ui.part("reload-failure");
  expect(note.tagName).toBe("P");
  expect(note).toHaveClass("ax-banner__note");
  expect(note).toHaveAttribute("role", "alert");
  expect(note).toHaveTextContent("The latest version could not be read. Your text is still here.");
  expect(note.previousElementSibling).toBe(ui.part("conflict-copy"));
  expect(childParts(ui.part("conflict"))).toEqual([null, "reload-latest", "keep-mine", "conflict-copy", "reload-failure"]);

  await act(async () => { fireEvent.click(ui.part("keep-mine")); });
  expect(ui.root).toHaveAttribute("data-state", "write-failed");
  expect(childParts(head)).toEqual(["toolbar", "status", "conflict", "write-failure"]);
});

test("AC2 puts the lead and note on full rows and reaches the ink contrast floor in all three themes", () => {
  expect(css.replace(/\s+/g, " ").trim()).toBe(".ax-banner__lead, .ax-banner__note { flex: 1 1 100%; }");
  expect(css).not.toMatch(/box-shadow|transition|animation|border-left|border-right|severity-break|spinner/);
  for (const { name, ink, raised } of draftThemeColors()) {
    expect(contrast(ink, raised), `${name} conflict ink`).toBeGreaterThanOrEqual(7);
  }
});
