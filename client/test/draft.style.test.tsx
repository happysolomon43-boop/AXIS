import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { Draft } from "../src/draft/Draft";
import css from "../src/draft/draft.css?raw";
import draftSource from "../src/draft/Draft.tsx?raw";
import binderSyncCss from "../src/styles/binder-sync.css?raw";
import { deferred, internalError, mockApi } from "./helpers";
import { c, chapterA, chapterPath, detailText, reply, writtenC } from "./d06.fixtures";
import { advance, contrast as draftContrast, draftNone, edit, fakeClock, mountDraft, noDraftRead, putOk } from "./draftFixtures";
import { internalEnvelope } from "./historyFixtures";
import {
  detailAfterRestore, mountRestore, restoredText, syncDraftOnly, syncEdited, syncInBook,
  syncRevised, syncRevisedSame, withSync,
} from "./syncDraftFixtures";

afterEach(() => vi.useRealTimers());

function mount() {
  const onReady = vi.fn<(view: EditorView) => void>();
  const { container } = render(<Draft chapterId={chapterA.id} onLockChange={vi.fn()} onWritten={vi.fn()} onEditorReady={onReady} />);
  const root = container.querySelector('[data-surface="draft"]')!;
  return { root, part: (name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!, edit: () => {
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
    noDraftRead,
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
    expect([...head.children].filter(el=>!el.classList.contains("ax-draft__snapshot-feedback")).map(el => el.getAttribute("data-part"))).toEqual(failure ? ["toolbar", "status", "write-failure"] : ["toolbar", "status"]);
    expect(head.nextElementSibling).toBe(m.part("page"));
    expect(m.part("page")).toContainElement(m.part("leaf"));
    expect(m.part("save")).toHaveClass("ax-button", "ax-button--secondary");
    expect(m.part("send")).toHaveClass("ax-button", m.part("send").getAttribute("aria-disabled") === "true" ? "ax-button--secondary" : "ax-button--primary");
  };
  assertHead(false); m.edit(); assertHead(false);
  fireEvent.click(m.part("send")); await waitFor(() => expect(m.part("status")).toHaveAttribute("data-outcome", "sent")); assertHead(false); expect(m.part("send")).toHaveClass("ax-button--secondary"); cleanup();
  for (const state of ["write-failed", "check-failed"] as const) {
    mockApi([
      noDraftRead,
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

test("AXB-0081 AC1 uses the shared text-only chip and leaves the other toolbar controls in place", async () => {
  const assertChip = (chip: HTMLElement, text: string) => {
    expect(chip).toHaveTextContent(text);
    expect(chip).toHaveClass("ax-binder__sync");
    for (const attribute of ["role", "aria-live", "style", "data-state", "tabindex", "title"]) {
      expect(chip).not.toHaveAttribute(attribute);
    }
  };
  for (const [sync, text] of [
    [syncDraftOnly, "Draft only"], [syncInBook, null], [syncEdited, "In Book, edited since upload"],
    [syncRevisedSame, "Being revised, no changes yet"], [syncRevised, "Being revised"],
  ] as const) {
    const ui = mountDraft({
      draft: withSync({ status: 200, body: draftNone }, sync),
      put: withSync({ status: 200, body: putOk(1) }, syncEdited),
    });
    await ui.loaded();
    if (text === null) {
      expect(ui.part("version-chip")).toBeNull();
      fakeClock();
      edit(ui.view());
      expect(ui.part("version-chip")).toBeNull();
      await advance(2000);
      expect(ui.root).toHaveAttribute("data-autosave", "saved");
      assertChip(ui.part("version-chip"), "In Book, edited since upload");
    } else {
      assertChip(ui.part("version-chip"), text);
    }
    const toolbar = ui.part("toolbar");
    expect([...toolbar.children].map((el) => el.getAttribute("data-part")).filter((part) => part !== "version-chip"))
      .toEqual(["autosave", "snapshot", "save", "send"]);
    expect(toolbar.querySelector("[style]")).toBeNull();
    expect(ui.root.querySelector(".ax-binder__pullback, .ax-binder__pullback-failure")).toBeNull();
    ui.unmount();
    vi.useRealTimers();
  }
});

test("AXB-0081 AC2 reuses the exact shared chip rule and meets the room and raised contrast floors", () => {
  const rule = binderSyncCss.match(/\.ax-binder__sync\s*\{[^}]*\}/)?.[0];
  const expected = `
    .ax-binder__sync {
      box-sizing: border-box;
      max-inline-size: 100%;
      block-size: auto;
      min-block-size: 20px;
      white-space: normal;
      overflow-wrap: anywhere;
      text-align: start;
      color: var(--ax-color-text-secondary);
    }
  `;
  expect(rule?.replace(/\s+/g, "")).toBe(expected.replace(/\s+/g, ""));
  const imports = Array.from(draftSource.matchAll(/^import "([^"]+\.css)";$/gm), ([, path]) => path);
  expect(imports).toEqual(["./draft.css", "./autosave.css", "./conflict.css", "../styles/binder-sync.css", "../styles/draft-snapshot.css"]);
  for (const [text, room, raised] of [
    ["#4A4D52", "#ECEBE6", "#FCFCFA"],
    ["#A9A79F", "#0B0C0E", "#0E1012"],
    ["#4F4636", "#D8CAAD", "#F6EEDD"],
  ]) {
    expect(Math.floor(draftContrast(text, room))).toBeGreaterThanOrEqual(4.5);
    expect(Math.floor(draftContrast(text, raised))).toBeGreaterThanOrEqual(4.5);
  }
});

test("AXB-0081 AC3 draws no loading treatment and preserves focus during a landed Restore", async () => {
  const chapter = deferred<ReturnType<typeof reply>>();
  const headReply = withSync({ status: 200, body: draftNone }, syncEdited);
  const head = deferred<typeof headReply>();
  const ui = await mountRestore({ chapter: () => chapter.promise, head: () => head.promise });
  const root = ui.root();
  const className = root.className;
  const previousEditor = ui.part("editor", root);
  ui.part("history-door").focus();
  await act(async () => { fireEvent.click(ui.part("version-restore")); });
  const focus = document.activeElement;
  expect(focus).toBe(ui.part("history-door"));

  const quiet = () => {
    expect(ui.root()).toBe(root);
    expect(root).toHaveAttribute("data-state", "reloading");
    expect(root.className).toBe(className);
    expect(previousEditor).toHaveTextContent("Two");
    expect(ui.part("editor", root)).toBe(previousEditor);
    expect(root.querySelector('[data-part="reading"], .ax-reading-rule, [data-part="conflict"]')).toBeNull();
    expect(ui.part("status", root)).toBeEmptyDOMElement();
    expect(ui.part("toolbar", root).querySelector("[style]")).toBeNull();
    expect(document.activeElement).toBe(focus);
  };
  quiet();
  await act(async () => { chapter.resolve(reply(detailAfterRestore)); });
  quiet();
  await act(async () => { head.resolve(headReply); });
  expect(ui.root()).toBe(root);
  expect(root).toHaveAttribute("data-state", "clean");
  expect(root.className).toBe(className);
  expect(ui.part("editor", root)).toHaveTextContent(restoredText);
  expect(ui.part("version-chip", root)).toHaveClass("ax-binder__sync");
  expect(ui.part("version-chip", root)).toHaveTextContent("In Book, edited since upload");
  expect(document.activeElement).toBe(focus);
});

test("AXB-0081 AC4 a failed Restore reload uses the existing conflict alerts and stopped autosave dot", async () => {
  const ui = await mountRestore({ initialSync: syncRevisedSame, chapter: internalEnvelope });
  const root = ui.root();
  const chip = ui.part("version-chip", root);
  const editor = ui.part("editor", root);
  await act(async () => { fireEvent.click(ui.part("version-restore")); });
  expect(ui.root()).toBe(root);
  expect(root).toHaveAttribute("data-state", "conflict");
  expect(root).toHaveAttribute("data-autosave", "stopped");
  const conflict = ui.part("conflict", root);
  expect(conflict).toHaveAttribute("role", "alert");
  expect(conflict).toHaveClass("ax-banner");
  expect(conflict.querySelector(".ax-banner__mark")).toBeNull();
  expect(ui.part("reload-failure", root)).toHaveAttribute("role", "alert");
  expect(ui.part("autosave-dot", root)).toHaveClass("ax-autosave__dot");
  expect(ui.part("editor", root)).toBe(editor);
  expect(editor).toHaveTextContent("Two");
  expect(ui.part("version-chip", root)).toBe(chip);
  expect(chip).toHaveTextContent("Being revised, no changes yet");
  expect(root.querySelector('[data-part="reading"], .ax-binder__pullback-failure')).toBeNull();
  expect(ui.part("toolbar", root).querySelector("[style]")).toBeNull();
});
