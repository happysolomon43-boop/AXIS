import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import css from "../src/draft/draft.css?raw";
import { deferred, internalError, mockApi } from "./helpers";
import { c, chapterA, chapterPath, detailText, reply, writtenC } from "./d06.fixtures";

function mount() {
  const onReady = vi.fn<(view: EditorView) => void>();
  const { container } = render(<Draft chapterId={chapterA.id} onLockChange={vi.fn()} onWritten={vi.fn()} onEditorReady={onReady} />);
  const root = container.querySelector('[data-surface="draft"]')!;
  return { root, part: (name: string) => root.querySelector(`[data-part="${name}"]`)!, edit: () => {
    const view = onReady.mock.calls[0][0]; act(() => view.dispatch(view.state.tr.insertText("!", view.state.doc.content.size - 1)));
  } };
}
function contrast(a: string, b: string) {
  const lum = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v, i) => (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i])
    .reduce((x, y) => x + y, 0);
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

test("AXB-0040 AC5 draws the sticky head, actions and exact failure banner, with design contrasts", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  mockApi([
    { method: "GET", path: chapterPath, reply: () => pending.promise },
    { method: "POST", path: `${chapterPath}/send`, reply: reply(writtenC(c), 201) },
  ]);
  let m = mount();
  expect(m.root).toHaveClass("ax-draft");
  expect(m.part("reading").nextElementSibling).toHaveClass("ax-reading-rule");
  expect(m.part("reading").nextElementSibling).toHaveAttribute("aria-hidden", "true");
  await act(async () => pending.resolve(reply(detailText)));
  await waitFor(() => expect(m.root).toHaveAttribute("data-state", "clean"));
  const assertHead = (failure: boolean) => {
    const head = m.part("draft-head");
    expect(head).toHaveClass("ax-draft-head");
    expect([...head.children].map(el => el.getAttribute("data-part"))).toEqual(failure ? ["toolbar", "status", "write-failure"] : ["toolbar", "status"]);
    expect(head.nextElementSibling).toBe(m.part("page"));
    expect(m.part("page")).toContainElement(m.part("leaf"));
    expect(m.part("save")).toHaveClass("ax-button", "ax-button--secondary");
    expect(m.part("send")).toHaveClass("ax-button", m.part("send").getAttribute("aria-disabled") === "true" ? "ax-button--secondary" : "ax-button--primary");
  };
  assertHead(false); m.edit(); assertHead(false);
  fireEvent.click(m.part("send")); await waitFor(() => expect(m.part("status")).toHaveAttribute("data-outcome", "sent")); assertHead(false); expect(m.part("send")).toHaveClass("ax-button--secondary"); cleanup();
  for (const state of ["write-failed", "check-failed"] as const) {
    mockApi([
      { method: "GET", path: chapterPath, reply: (_, n) => n === 1 && state === "check-failed" ? internalError : reply(detailText) },
      { method: "POST", path: `${chapterPath}/versions`, reply: internalError },
    ]);
    m = mount(); await waitFor(() => expect(m.root).toHaveAttribute("data-state", "clean")); m.edit(); fireEvent.click(m.part("save"));
    await waitFor(() => expect(m.root).toHaveAttribute("data-state", state)); assertHead(true);
    expect(m.part("write-failure")).toHaveClass("ax-banner");
    expect(m.part("write-failure").firstElementChild).toBe(m.part("not-saved-mark"));
    expect(m.part("not-saved-mark")).toHaveClass("ax-banner__mark"); expect(m.part("not-saved-mark")).toHaveTextContent("Not saved");
    expect(m.part("copy-chapter")).toHaveClass("ax-button--secondary");
    if (state === "check-failed") expect(m.part("check-again")).toHaveClass("ax-button--secondary"); cleanup();
  }
  expect(css.replace(/\s+/g, "")).toBe(expectedCss.replace(/\s+/g, ""));
  expect(css.match(/severity-break/g)).toHaveLength(1); expect(css).not.toMatch(/animation|box-shadow|border-left|border-right/);
  for (const [red, raised, text, room] of [["#B42318", "#FCFCFA", "#4A4D52", "#ECEBE6"], ["#F2766B", "#0E1012", "#A9A79F", "#0B0C0E"], ["#A31F14", "#F6EEDD", "#4F4636", "#D8CAAD"]]) {
    expect(contrast(red, raised)).toBeGreaterThanOrEqual(4.5); expect(contrast(text, room)).toBeGreaterThanOrEqual(4.5);
  }
});

const expectedCss = `
.ax-text-region { overflow-x: hidden; }
.ax-draft { display: flex; flex-direction: column; min-block-size: 100%; }
.ax-draft-head { position: sticky; inset-block-start: 0; z-index: var(--ax-z-shell); background-color: var(--ax-color-surface-shell); }
.ax-draft-page { display: flex; flex: 1 1 auto; justify-content: center; }
.ax-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--ax-space-3); padding-block: var(--ax-space-3); padding-inline: var(--ax-space-6); min-block-size: var(--ax-size-strip); }
[data-part="version-chip"] { margin-inline-end: auto; box-sizing: border-box; min-block-size: 20px; padding-block: 1px; padding-inline: var(--ax-space-2); border: 1px solid var(--ax-color-border-hair); border-radius: var(--ax-radius-1); color: var(--ax-color-text-secondary); font-size: var(--ax-type-caption-size); line-height: var(--ax-type-caption-lh); letter-spacing: var(--ax-type-caption-tracking); overflow-wrap: anywhere; }
.ax-draft-status { display: flex; align-items: center; margin: 0; padding-inline: var(--ax-space-6); min-block-size: var(--ax-size-status-line); color: var(--ax-color-text-secondary); font-size: var(--ax-type-small-size); line-height: var(--ax-type-small-lh); }
.ax-draft [data-part="reading"], .ax-draft [data-part="read-failure"] { margin-block-start: var(--ax-space-8); margin-inline: var(--ax-space-6); }
.ax-draft [data-part="read-failure"] { color: var(--ax-color-text-primary); font-size: var(--ax-type-body-size); line-height: var(--ax-type-body-lh); display: flex; flex-direction: column; align-items: flex-start; gap: var(--ax-space-3); }
.ax-draft [data-part="reading"] + .ax-reading-rule { margin-block-start: var(--ax-space-3); margin-inline: var(--ax-space-6); }
[data-part="send"] { transition: background-color var(--ax-dur-chip) var(--ax-ease-state), border-color var(--ax-dur-chip) var(--ax-ease-state), color var(--ax-dur-chip) var(--ax-ease-state); }
@media (prefers-reduced-motion: reduce) { [data-part="send"] { transition: none; } }
.ax-banner { display: flex; flex-wrap: wrap; align-items: center; gap: var(--ax-space-3); box-sizing: border-box; min-block-size: var(--ax-size-banner); padding-block: var(--ax-space-3); padding-inline: var(--ax-space-6); background-color: var(--ax-color-surface-raised); color: var(--ax-color-text-primary); border-block-end: 1px solid var(--ax-color-border-hair); font-size: var(--ax-type-body-size); line-height: var(--ax-type-body-lh); }
.ax-banner > p { margin: 0; }
.ax-banner__mark { color: var(--ax-color-severity-break); font-weight: 600; }
`;
