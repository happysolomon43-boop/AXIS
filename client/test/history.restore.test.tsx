import { receiptPath, receiptRoute, writeResponse, writeResult } from "./writeFixtures";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { History, type OnRestored } from "../src/history/History";
import { reply } from "./d06.fixtures";
import { deferred, mockApi, type Call } from "./helpers";
import { chapterA, historyPath, versionPath, versionTextA, versionTextB, versionTextC } from "./historyFixtures";
import {
  historyAfterCheckpoint, historyH3, internalEnvelope, restorePath,
  restoreReply, restoreReplyCp, rowA, rowB, rowC,
} from "./restoreFixtures";

type Handler = Parameters<typeof mockApi>[0][number];
const applied = "Restored into your draft. The Book is unchanged until you send.";
const kept = "Restored as a new version. The text in your draft was not replaced.";

function setup({
  post = restoreReply, history = reply(historyH3), versionB = reply(versionTextB),
  onRestored = vi.fn<OnRestored>(() => "applied"), receipt = reply({ receipt: null }),
}: {
  post?: Handler["reply"]; history?: Handler["reply"]; versionB?: Handler["reply"]; onRestored?: OnRestored; receipt?: Handler["reply"];
} = {}) {
  const { calls } = mockApi([
    { method: "GET", path: historyPath, reply: history },
    { method: "GET", path: versionPath(rowA.id), reply: reply({ ...versionTextA, blocks: [] }) },
    { method: "GET", path: versionPath(rowB.id), reply: versionB },
    { method: "GET", path: versionPath(rowC.id), reply: reply(versionTextC) },
    { method: "POST", path: restorePath, reply: async (call, n) => writeResponse(call, typeof post === "function" ? await post(call, n) : post) },
    { method: "GET", path: receiptRoute, reply: receipt },
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
    ...ui, part, rows, open, onRestored, calls,
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
    version_id: restoreReply.body.version.id, checkpoint_version_id: null, draft_current: true,
  });
  const status = ui.part("restore-status");
  expect(status).toHaveAttribute("role", "status");
  expect(status.textContent).toBe(applied);
  expect(status.nextElementSibling).toBe(ui.part("snapshot-filter"));
  expect(ui.part("snapshot-filter").nextElementSibling).toBe(ui.part("snapshot-name-status"));
  expect(ui.part("snapshot-name-status").nextElementSibling).toBe(ui.part("snapshot-lifecycle-status").parentElement);
  expect(ui.part("snapshot-lifecycle-status").parentElement?.nextElementSibling).toBe(ui.part("version-list"));
  expect(ui.part("version-actions")).toHaveAttribute("data-state", "idle");
  expect(ui.button()).not.toHaveAttribute("aria-disabled");
  expect(ui.button()).toHaveFocus();
  expect(ui.historyReads()).toBe(2);
  ui.unmount();

  const keptUi = setup({ post: restoreReplyCp, onRestored: () => "kept" });
  await keptUi.open();
  await act(async () => { fireEvent.click(keptUi.button()); });
  expect(keptUi.part("restore-status").textContent).toBe(
    `${kept} Your unsaved text was kept as the snapshot “Before restore”.`,
  );
  fireEvent.click(keptUi.rows()[1]);
  expect(keptUi.part("restore-status")).toBeNull();
});

test("AC3 checks one receipt after loss, leaves absence unresolved and retries only the receipt read", async () => {
  let pressed: Call;
  const ui = setup({
    post: call => { pressed = call; return "network"; },
    history: (_, n) => reply(n === 0 ? historyH3 : historyAfterCheckpoint),
    receipt: (_, n) => {
      const written = writeResult(pressed, restoreReplyCp.body);
      if (n === 0) return reply({ receipt: null });
      if (n === 1) return reply({ receipt: { ...written, request_id: "11111111-1111-4111-8111-111111111111" } });
      return reply({ receipt: written });
    },
  });
  await ui.open();
  ui.button().focus();
  await act(async () => { fireEvent.click(ui.button()); });
  expect(ui.part("restore-failure")).toHaveAttribute("role", "status");
  expect(ui.part("restore-failure")).toHaveTextContent("The restore could not be confirmed.");
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.button()).toHaveFocus();
  expect(ui.historyReads()).toBe(1);
  fireEvent.click(ui.button());
  expect(ui.posts()).toHaveLength(1);
  await act(async () => { fireEvent.click(ui.part("restore-check-again")); });
  expect(ui.onRestored).not.toHaveBeenCalled();
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  await act(async () => { fireEvent.click(ui.part("restore-check-again")); });
  expect(ui.onRestored).toHaveBeenCalledTimes(1);
  expect(ui.onRestored).toHaveBeenCalledWith({
    version_id: restoreReplyCp.body.version.id, checkpoint_version_id: restoreReplyCp.body.checkpoint_version_id, draft_current: true,
  });
  expect(ui.part("restore-failure")).toBeNull();
  expect(ui.part("restore-status")).toHaveTextContent(`${applied} Your unsaved text was kept as the snapshot “Before restore”.`);
  expect(ui.rows()).toHaveLength(historyAfterCheckpoint.versions.length);
  expect(ui.posts()).toHaveLength(1);
  expect(ui.historyReads()).toBe(2);
  const expected = receiptPath("/api/chapters/" + chapterA.id, (pressed!.body as { request_id: string }).request_id);
  expect(ui.calls.filter(call => receiptRoute.test(call.path)).map(call => [call.method, call.path])).toEqual(Array(3).fill(["GET", expected]));
});

test("an older verified Restore never borrows a later checkpoint or reloads a newer Draft", async () => {
  let pressed: Call;
  const ui = setup({
    post: call => { pressed = call; return internalEnvelope; },
    history: (_, n) => reply(n === 0 ? historyH3 : historyAfterCheckpoint),
    receipt: () => {
      const written = writeResult(pressed, restoreReply.body);
      return reply({ receipt: { ...written, current: { ...written.current, version_id: restoreReplyCp.body.version.id } } });
    },
  });
  await ui.open();
  await act(async () => { fireEvent.click(ui.button()); });
  expect(ui.onRestored).toHaveBeenCalledTimes(1);
  expect(ui.onRestored).toHaveBeenCalledWith({
    version_id: restoreReply.body.version.id, checkpoint_version_id: null, draft_current: false,
  });
  expect(ui.part("restore-status").textContent).toBe(kept);
  expect(ui.posts()).toHaveLength(1);
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
        version_id: restoreReply.body.version.id, checkpoint_version_id: null, draft_current: true,
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
    version_id: restoreReply.body.version.id, checkpoint_version_id: null, draft_current: true,
  });
  expect(ui.part("restore-status").textContent).toBe(applied);
  expect(ui.button()).toHaveAttribute("aria-disabled", "true");
  expect(ui.historyReads()).toBe(2);
});
