import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { History } from "../src/history/History";
import { chapter, chapterPath, choices, history, ok, preview, previewPath, rows, v1, v3 } from "./d20Fixtures";
import { deferred, mockApi } from "./helpers";

const historyPath = `${chapterPath}/history`;
const openSelected = (id = v1) => fireEvent.click(document.querySelector(`[data-version-id="${id}"] [data-part=version-open]`)!);
const button = () => screen.findByRole("button", { name: "Compare" });
const failure = { status: 500, body: { error: { code: "internal", message: "Internal error", details: null } } };

function drawing(compare: HTMLElement, hasRestore = true) {
  expect(compare.tagName).toBe("BUTTON");
  expect(compare).toHaveAttribute("type", "button");
  expect(compare).toHaveAttribute("data-part", "compare");
  expect(compare).toHaveClass("ax-button", "ax-button--quiet", "ax-history__compare");
  expect(compare.parentElement).toHaveClass("ax-history__actions");
  if (hasRestore) expect(compare.previousElementSibling).toHaveAttribute("data-part", "version-restore");
  else expect(compare.parentElement?.firstElementChild).toBe(compare);
}
function reason(compare: HTMLElement) {
  expect(compare).toHaveAttribute("aria-disabled", "true");
  expect(compare).toHaveAccessibleDescription("Comparison is unavailable right now.");
  expect(compare.nextElementSibling).toHaveAttribute("data-part", "compare-reason");
  expect(compare.nextElementSibling).toHaveClass("ax-history__note", "ax-history__compare-reason");
  expect(compare.nextElementSibling).not.toHaveAttribute("role");
  expect(compare.nextElementSibling).not.toHaveAttribute("aria-live");
}

test("AC1 opens from Named using a frozen full catalogue and the selected saved version", async () => {
  const onCompare = vi.fn(() => true);
  const api = mockApi([{ method: "GET", path: historyPath, reply: ok(history) },
    { method: "GET", path: previewPath(v1), reply: ok(preview(v1)) }]);
  render(<History chapterId={chapter.id} timeZone="UTC" onCompare={onCompare} compareEditorAvailable />);
  fireEvent.click(await screen.findByRole("button", { name: "Named" }));
  expect(document.querySelectorAll("[data-part=version]")).toHaveLength(1);
  openSelected();
  const compare = await button();
  drawing(compare);
  expect(compare).not.toHaveAttribute("aria-describedby");
  expect(compare).not.toHaveAttribute("aria-disabled");
  fireEvent.click(compare);
  expect(onCompare.mock.calls).toEqual([[chapter.id, choices, v1, v3]]);
  const launch = (onCompare.mock.calls as unknown[][])[0][1] as object[];
  expect(Object.isFrozen(launch)).toBe(true);
  expect(launch.every(row => Object.isFrozen(row) && Object.keys(row).length === 6)).toBe(true);
  expect(api.calls.map(call => [call.method, call.path])).toEqual([["GET", historyPath], ["GET", previewPath(v1)]]);
});

test("AC2 omits Compare from empty, loading and failed lists and pending or failed preview", async () => {
  const pending = deferred<typeof failure>();
  const onCompare = vi.fn(() => true);
  const api = mockApi([
    { method: "GET", path: historyPath, reply: (_, n) => n === 0 ? pending.promise : n === 1
      ? ok({ ...history, versions: [] }) : ok(history) },
    { method: "GET", path: previewPath(v1), reply: failure },
  ]);
  const mount = () => render(<History chapterId={chapter.id} onCompare={onCompare} compareEditorAvailable />);
  const ui = mount();
  expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  await act(async () => pending.resolve(failure));
  expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  fireEvent.click(document.querySelector("[data-part=try-again]")!);
  expect(await screen.findByText("No versions yet.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  ui.unmount();
  mount();
  await screen.findByRole("button", { name: /Saved/ });
  openSelected();
  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(retry).toHaveAttribute("data-part", "version-try-again");
  expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  await act(async () => fireEvent.click(retry));
  expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  expect(onCompare).not.toHaveBeenCalled();
  expect(api.calls.map(call => call.path)).toEqual([historyPath, historyPath, historyPath, previewPath(v1), previewPath(v1)]);
});

test("AC3 refuses invalid catalogues and a live Restore without disabling focus or invoking the handler", async () => {
  const user = userEvent.setup();
  const onCompare = vi.fn(() => true);
  for (const versions of [
    [rows[0], rows[1], rows[1], rows[2]],
    [rows[0], { ...rows[1], chapter_id: "wrong" }, rows[2]],
    [rows[0], { ...rows[1], at: "2026-02-30T10:00:00.000Z" }, rows[2]],
    [rows[0], { ...rows[1], version_no: 3 }, rows[2]],
  ]) {
    mockApi([{ method: "GET", path: historyPath, reply: ok({ ...history, versions }) },
      { method: "GET", path: previewPath(v1), reply: ok(preview(v1)) }]);
    const ui = render(<History chapterId={chapter.id} onCompare={onCompare} compareEditorAvailable />);
    await screen.findByRole("button", { name: /Saved/ });
    openSelected();
    const compare = await button();
    drawing(compare);
    reason(compare);
    compare.focus();
    expect(compare).toHaveFocus();
    await user.keyboard("{Enter} ");
    await user.click(compare);
    ui.unmount();
  }
  const pending = deferred<typeof failure>();
  const api = mockApi([{ method: "GET", path: historyPath, reply: ok(history) },
    { method: "GET", path: previewPath(v1), reply: ok(preview(v1)) },
    { method: "POST", path: `${chapterPath}/restore`, reply: () => pending.promise }]);
  const ui = render(<History chapterId={chapter.id} onCompare={onCompare} compareEditorAvailable />);
  await screen.findByRole("button", { name: /Saved/ });
  openSelected();
  const compare = await button();
  fireEvent.click(document.querySelector("[data-part=version-restore]")!);
  reason(compare);
  compare.focus();
  await user.keyboard("{Enter} ");
  await user.click(compare);
  expect(onCompare).not.toHaveBeenCalled();
  expect(api.calls.filter(call => call.path.endsWith("/text"))).toHaveLength(0);
  expect(api.calls.filter(call => call.method === "POST")).toHaveLength(1);
  ui.unmount();
  await act(async () => pending.resolve(failure));
});

test("AC4 singleton newest-row action retains focus after a live refusal and can then succeed", async () => {
  const onCompare = vi.fn<(...args: unknown[]) => boolean>().mockReturnValueOnce(false).mockReturnValueOnce(true);
  mockApi([{ method: "GET", path: historyPath, reply: ok({ ...history, versions: [rows[2]] }) },
    { method: "GET", path: previewPath(v1), reply: ok(preview(v1)) }]);
  render(<History chapterId={chapter.id} onCompare={onCompare} compareEditorAvailable />);
  await screen.findByRole("button", { name: /Saved/ });
  openSelected();
  const compare = await button();
  drawing(compare, false);
  fireEvent.click(compare);
  expect(compare).toHaveFocus();
  reason(compare);
  fireEvent.click(compare);
  expect(onCompare.mock.calls).toEqual([
    [chapter.id, [choices[2]], v1, null], [chapter.id, [choices[2]], v1, null],
  ]);
  expect(document.querySelector("[data-part=version-restore]")).toBeNull();
});
