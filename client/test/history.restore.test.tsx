import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { History, type OnRestored } from "../src/history/History";
import { reply } from "./d06.fixtures";
import { deferred, mockApi } from "./helpers";
import { chapterA, historyPath, versionPath, versionTextA, versionTextB, versionTextC } from "./historyFixtures";
import {
  historyAfterCheckpoint, historyAfterRestore, historyH3, internalEnvelope, restorePath,
  restoreReply, restoreReplyCp, rowA, rowB, rowC,
} from "./restoreFixtures";

type Handler = Parameters<typeof mockApi>[0][number];
const applied = "Restored into your draft. The Book is unchanged until you send.";
const kept = "Restored as a new version. The text in your draft was not replaced.";
const failed = "The version could not be restored.";

function setup({
  post = restoreReply, history = reply(historyH3), versionB = reply(versionTextB),
  onRestored = vi.fn<OnRestored>(() => "applied"),
}: {
  post?: Handler["reply"]; history?: Handler["reply"]; versionB?: Handler["reply"]; onRestored?: OnRestored;
} = {}) {
  const { calls } = mockApi([
    { method: "GET", path: historyPath, reply: history },
    { method: "GET", path: versionPath(rowA.id), reply: reply({ ...versionTextA, blocks: [] }) },
    { method: "GET", path: versionPath(rowB.id), reply: versionB },
    { method: "GET", path: versionPath(rowC.id), reply: reply(versionTextC) },
    { method: "POST", path: restorePath, reply: post },
  ]);
  const component = (locked = false, notify = onRestored) =>
    <History chapterId={chapterA.id} timeZone="UTC" locked={locked} onRestored={notify} />;
  const ui = render(component());
  const part = (name: string) => ui.container.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const rows = () => [...ui.container.querySelectorAll('[data-part="version-open"]')];
  const open = async (index = 1) => {
    await waitFor(() => expect(rows()).toHaveLength(3));
    await act(async () => { fireEvent.click(rows()[index]); });
  };
  return {
    ...ui, part, rows, open, onRestored,
    button: () => part("version-restore"),
    update: (locked: boolean, notify?: OnRestored) => ui.rerender(component(locked, notify)),
    posts: () => calls.filter(({ method }) => method === "POST"),
    historyReads: () => calls.filter(({ method, path }) => method === "GET" && path === historyPath).length,
  };
}

test("AC1 offers Restore only after the preview on non-newest rows, with the lock guard", async () => {
  const version = deferred<typeof internalEnvelope>();
  const ui = setup({ versionB: (_, n) => n === 0 ? version.promise : reply(versionTextB) });
  await ui.open(0);
  expect(ui.part("version-detail")).toHaveAttribute("data-state", "ready");
  expect(ui.part("version-actions")).toBeNull();

  await ui.open();
  expect(ui.part("version-detail")).toHaveAttribute("data-state", "loading");
  expect(ui.part("version-actions")).toBeNull();
  await act(async () => { version.resolve(internalEnvelope); });
  expect(ui.part("version-detail")).toHaveAttribute("data-state", "failed");
  expect(ui.part("version-actions")).toBeNull();

  await act(async () => { fireEvent.click(ui.part("version-try-again")); });
  const actions = ui.part("version-actions");
  expect(actions.tagName).toBe("DIV");
  expect(actions).toHaveAttribute("data-state", "idle");
  expect([...ui.part("version-detail").children].map((node) => node.getAttribute("data-part"))).toEqual([
    "preview-line", "preview-line", "preview-line", "version-actions",
  ]);
  expect(actions).toContainElement(ui.button());
  expect(ui.button()).toHaveTextContent(/^Restore this version$/);
  expect(ui.button()).toHaveAttribute("type", "button");
  expect(ui.button()).not.toHaveAttribute("aria-disabled");
  expect(ui.part("restore-blocked")).toBeNull();

  await ui.open(2);
  expect(ui.part("no-text").nextElementSibling).toBe(ui.part("version-actions"));
  await ui.open();
  ui.update(true);
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.button()).not.toHaveAttribute("disabled");
  expect(ui.part("restore-blocked")).toHaveAttribute("role", "status");
  expect(ui.part("restore-blocked")).toHaveTextContent(/^Finish saving this chapter before restoring a version\.$/);
  ui.button().focus();
  fireEvent.click(ui.button());
  expect(ui.button()).toHaveFocus();
  expect(ui.posts()).toHaveLength(0);
});

test("AC2 posts once, reports the captured outcome and preserves Restore focus", async () => {
  const post = deferred<typeof restoreReply>();
  const ui = setup({ post: () => post.promise });
  await ui.open();
  ui.button().focus();
  fireEvent.click(ui.button());
  expect(ui.posts()).toMatchObject([{ method: "POST", path: restorePath, body: { version_id: rowB.id } }]);
  expect(ui.part("version-actions")).toHaveAttribute("data-state", "restoring");
  expect(ui.button()).toHaveTextContent(/^Restoring\.\.\.$/);
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.button()).toHaveFocus();
  fireEvent.click(ui.button());
  await ui.open(2);
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.button()).toHaveTextContent(/^Restore this version$/);
  fireEvent.click(ui.button());
  expect(ui.posts()).toHaveLength(1);
  await ui.open();
  ui.button().focus();

  await act(async () => { post.resolve(restoreReply); });
  expect(ui.onRestored).toHaveBeenCalledTimes(1);
  expect(ui.onRestored).toHaveBeenCalledWith({
    version_id: restoreReply.body.version.id, checkpoint_version_id: null,
  });
  const status = ui.part("restore-status");
  expect(status).toHaveAttribute("role", "status");
  expect(status.textContent).toBe(applied);
  expect(status.nextElementSibling).toBe(ui.part("version-list"));
  expect(ui.part("version-actions")).toHaveAttribute("data-state", "idle");
  expect(ui.button()).not.toHaveAttribute("aria-disabled");
  expect(ui.button()).toHaveFocus();
  expect(ui.historyReads()).toBe(1);
  ui.unmount();

  const keptUi = setup({ post: restoreReplyCp, onRestored: () => "kept" });
  await keptUi.open();
  await act(async () => { fireEvent.click(keptUi.button()); });
  expect(keptUi.part("restore-status").textContent).toBe(
    `${kept} Your earlier unsaved text was kept as a checkpoint.`,
  );
  fireEvent.click(keptUi.rows()[1]);
  expect(keptUi.part("restore-status")).toBeNull();
});

test("AC3 settles a failed restore once and only offers it again after a successful read", async () => {
  const settle = deferred<ReturnType<typeof reply>>();
  let ui = setup({ post: internalEnvelope, history: (_, n) => n === 1 ? settle.promise : reply(historyH3) });
  await ui.open();
  ui.button().focus();
  await act(async () => { fireEvent.click(ui.button()); });
  expect(ui.part("restore-failure")).toHaveAttribute("role", "status");
  expect(ui.part("restore-failure").textContent).toBe(failed);
  expect(ui.rows()).toHaveLength(3);
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.button()).toHaveFocus();
  expect(ui.historyReads()).toBe(2);
  fireEvent.click(ui.button());
  expect(ui.posts()).toHaveLength(1);
  await act(async () => { settle.resolve(reply(historyH3)); });
  expect(ui.button()).not.toHaveAttribute("aria-disabled");
  expect(ui.button()).toHaveFocus();
  expect(ui.part("restore-failure").textContent).toBe(failed);
  expect(ui.onRestored).not.toHaveBeenCalled();
  expect(ui.posts()).toHaveLength(1);
  await act(async () => { fireEvent.click(ui.button()); });
  expect(ui.posts()).toHaveLength(2);
  fireEvent.click(ui.rows()[1]);
  expect(ui.part("restore-failure")).toBeNull();
  ui.unmount();

  for (const [history, written] of [[historyAfterRestore, restoreReply], [historyAfterCheckpoint, restoreReplyCp]] as const) {
    ui = setup({ post: "network", history: (_, n) => reply(n === 0 ? historyH3 : history) });
    await ui.open();
    await act(async () => { fireEvent.click(ui.button()); });
    expect(ui.onRestored).toHaveBeenCalledTimes(1);
    expect(ui.onRestored).toHaveBeenCalledWith({
      version_id: written.body.version.id, checkpoint_version_id: written.body.checkpoint_version_id,
    });
    expect(ui.part("restore-failure")).toBeNull();
    expect(ui.part("restore-status")).toBeInTheDocument();
    expect(ui.rows()).toHaveLength(history.versions.length);
    expect(ui.posts()).toHaveLength(1);
    expect(ui.historyReads()).toBe(2);
    ui.unmount();
  }

  ui = setup({ post: internalEnvelope, history: (_, n) => n === 1 ? internalEnvelope : reply(historyH3) });
  await ui.open();
  await act(async () => { fireEvent.click(ui.button()); });
  expect(ui.part("refresh-failure")).toHaveTextContent("The history could not be refreshed.");
  expect(ui.part("refresh-again")).toBeInTheDocument();
  expect(ui.part("refresh-again").nextElementSibling).toBe(ui.part("restore-failure"));
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.historyReads()).toBe(2);
  fireEvent.click(ui.button());
  expect(ui.posts()).toHaveLength(1);
  await act(async () => { fireEvent.click(ui.part("refresh-again")); });
  expect(ui.historyReads()).toBe(3);
  expect(ui.part("refresh-failure")).toBeNull();
  expect(ui.button()).not.toHaveAttribute("aria-disabled");
  expect(ui.part("restore-failure").textContent).toBe(failed);
});

test("AC4 uses the captured callback after a late success and skips settlement after unmount", async () => {
  for (const outcome of [restoreReply, internalEnvelope]) {
    const post = deferred<typeof outcome>();
    const ui = setup({ post: () => post.promise });
    await ui.open();
    fireEvent.click(ui.button());
    const replacement = vi.fn<OnRestored>(() => "kept");
    ui.update(false, replacement);
    ui.unmount();
    await act(async () => { post.resolve(outcome); });
    if (outcome === restoreReply) {
      expect(ui.onRestored).toHaveBeenCalledTimes(1);
      expect(ui.onRestored).toHaveBeenCalledWith({
        version_id: restoreReply.body.version.id, checkpoint_version_id: null,
      });
    } else {
      expect(ui.onRestored).not.toHaveBeenCalled();
    }
    expect(replacement).not.toHaveBeenCalled();
    expect(ui.container).toBeEmptyDOMElement();
    expect(ui.historyReads()).toBe(1);
    expect(ui.posts()).toHaveLength(1);
  }
  const post = deferred<typeof restoreReply>();
  const ui = setup({ post: () => post.promise });
  await ui.open();
  fireEvent.click(ui.button());
  ui.update(true);
  expect(ui.button()).toHaveTextContent(/^Restoring\.\.\.$/);
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  await act(async () => { post.resolve(restoreReply); });
  expect(ui.onRestored).toHaveBeenCalledTimes(1);
  expect(ui.onRestored).toHaveBeenCalledWith({
    version_id: restoreReply.body.version.id, checkpoint_version_id: null,
  });
  expect(ui.part("restore-status").textContent).toBe(applied);
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.historyReads()).toBe(1);
});
