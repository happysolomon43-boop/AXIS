import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { History, type OnRestored } from "../src/history/History";
import historySource from "../src/history/History.tsx?raw";
import css from "../src/history/restore.css?raw";
import { reply } from "./d06.fixtures";
import { contrast } from "./draftFixtures";
import { deferred, mockApi } from "./helpers";
import { chapterA, historyColors, historyPath, versionPath, versionTextB } from "./historyFixtures";
import { historyH3, internalEnvelope, restorePath, restoreReply, rowB } from "./restoreFixtures";

type Handler = Parameters<typeof mockApi>[0][number];

async function mount(post: Handler["reply"]) {
  mockApi([
    { method: "GET", path: historyPath, reply: reply(historyH3) },
    { method: "GET", path: versionPath(rowB.id), reply: reply(versionTextB) },
    { method: "POST", path: restorePath, reply: post },
  ]);
  const onRestored = vi.fn<OnRestored>(() => "applied");
  const view = (locked = false) =>
    <History chapterId={chapterA.id} timeZone="UTC" locked={locked} onRestored={onRestored} />;
  const ui = render(view());
  const root = ui.container.querySelector('[data-surface="history"]')!;
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  await waitFor(() => expect(root).toHaveAttribute("data-state", "ready"));
  await act(async () => { fireEvent.click(root.querySelectorAll('[data-part="version-open"]')[1]); });
  expect(part("version-detail")).toHaveAttribute("data-state", "ready");
  return { ...ui, root, part, update: (locked: boolean) => ui.rerender(view(locked)) };
}

test("AC1 draws a quiet Restore action and inline status in each state", async () => {
  const post = deferred<typeof restoreReply>();
  const ui = await mount(() => post.promise);
  const actions = ui.part("version-actions");
  const button = ui.part("version-restore");
  expect(actions).toHaveClass("ax-history__actions");
  expect(actions.children).toHaveLength(1);
  expect(actions.firstElementChild).toBe(button);
  expect([...button.classList]).toEqual(["ax-button", "ax-button--quiet", "ax-history__restore"]);
  expect(button).not.toHaveAttribute("disabled");
  expect(button).not.toHaveAttribute("aria-disabled");
  for (const name of ["restore-blocked", "restore-status", "restore-failure"]) expect(ui.part(name)).toBeNull();

  ui.update(true);
  expect(ui.part("restore-blocked")).toHaveClass("ax-history__note");
  expect(actions.lastElementChild).toBe(ui.part("restore-blocked"));
  expect(button).toHaveAttribute("aria-disabled", "true");

  ui.update(false);
  fireEvent.click(button);
  expect(button).toHaveTextContent("Restoring...");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).not.toHaveAttribute("disabled");
  await act(async () => { post.resolve(restoreReply); });
  const status = ui.part("restore-status");
  expect(status).toHaveClass("ax-history__note", "ax-history__result");
  expect(status.nextElementSibling).toBe(ui.part("snapshot-filter"));
  expect(ui.part("snapshot-filter").nextElementSibling).toBe(ui.part("snapshot-name-status"));
  expect(ui.part("snapshot-name-status").nextElementSibling).toBe(ui.part("version-list"));
  expect(ui.root).not.toHaveAttribute("style");
  expect(ui.root.querySelector("[style]")).toBeNull();
  ui.unmount();

  const failure = await mount(internalEnvelope);
  await act(async () => { fireEvent.click(failure.part("version-restore")); });
  expect(failure.part("restore-failure")).toHaveClass("ax-history__note", "ax-history__result");
  expect(failure.part("restore-failure").nextElementSibling).toBe(failure.part("snapshot-filter"));
  expect(failure.part("snapshot-filter").nextElementSibling).toBe(failure.part("snapshot-name-status"));
  expect(failure.part("snapshot-name-status").nextElementSibling).toBe(failure.part("version-list"));
});

test("AC2 declares exactly the Restore styles and meets the room contrast floor in every theme", () => {
  const expected = `
.ax-history__actions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ax-space-3);
  padding-inline-start: 32px;
}
.ax-history__restore {
  min-inline-size: 22ch;
  justify-content: center;
  text-align: center;
}
.ax-history__restore[aria-disabled="true"] {
  opacity: 0.4;
  cursor: default;
}
.ax-history__restore[aria-disabled="true"]:hover {
  background-color: transparent;
}
.ax-history__restore[aria-disabled="true"]:active {
  background-color: transparent;
}
.ax-history__result {
  position: sticky;
  inset-block-start: 0;
  z-index: 1;
  box-sizing: border-box;
  padding-block: var(--ax-space-3);
  background-color: var(--ax-color-surface-shell);
  border-block-end: 1px solid var(--ax-color-border-hair);
}
`;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  expect(normalize(css)).toBe(normalize(expected));
  expect(css).not.toMatch(/transition|animation|@keyframes|box-shadow|border-left|border-right|severity-break|color-presence|outline/);
  const tokens = new Set(["color-surface-shell", "color-text-primary", "color-border-hair", "space-3"]);
  for (const [, token] of css.matchAll(/var\(--ax-([\w-]+)/g)) expect(tokens.has(token), token).toBe(true);
  expect(historySource).toMatch(/import "\.\/history\.css";\s*import "\.\/restore\.css";/);

  for (const { theme, room, primary } of historyColors()) {
    expect(contrast(primary, room), theme).toBeGreaterThanOrEqual(7);
  }
});
