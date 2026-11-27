import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { History } from "../src/history/History";
import { reply } from "./d06.fixtures";
import { deferred, mockApi } from "./helpers";
import {
  chapterA, histA, histB, histC, histD, historyFour, historyNoActive, historyNone, historyPath, historyThree,
  historyTwo, internalEnvelope, versionPath, versionTextA, versionTextB, versionTextC, versionTextD,
} from "./historyFixtures";

type Handler = Parameters<typeof mockApi>[0][number];
const part = (root: Element, name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
const selectParts = (root: Element, name: string) => Array.from(root.querySelectorAll<HTMLElement>(`[data-part="${name}"]`));

function mount(handlers: Handler[]) {
  const { calls } = mockApi(handlers);
  const component = (refreshToken?: number) => <History chapterId={chapterA.id} refreshToken={refreshToken} timeZone="UTC" />;
  const ui = render(component());
  const root = ui.container.querySelector<HTMLElement>('[data-surface="history"]')!;
  const openRows = () => selectParts(root, "version-open");
  return {
    ...ui, root, openRows,
    part: (name: string) => part(root, name),
    row: (index: number) => openRows()[index],
    labels: () => openRows().map((button) => button.getAttribute("aria-label")),
    lines: () => selectParts(root, "preview-line").map((line) => line.textContent),
    paths: () => calls.map(({ method, path }) => [method, path]),
    count: (path: string) => calls.filter((entry) => entry.path === path).length,
    update: (token: number) => ui.rerender(component(token)),
    state: (expected = "ready") => waitFor(() => expect(root).toHaveAttribute("data-state", expected)),
  };
}

const reads = (replyToHistory: Handler["reply"], ...others: Handler[]) =>
  mount([{ method: "GET", path: historyPath, reply: replyToHistory }, ...others]);
const version = (id: string, body: Handler["reply"]): Handler => ({ method: "GET", path: versionPath(id), reply: body });
const firstThreeLabels = ["23 Oct 2026 16:12, Sent, 3 words, In Book", "22 Oct 2026 09:05, Saved, 3 words", "21 Oct 2026 18:30, Saved, 2 words"];

test("AC1 draws the served order, active mark, loading, empty and blocking retry", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  let ui = reads(() => pending.promise);
  expect(ui.root).toHaveAttribute("data-state", "loading");
  expect(ui.root).toHaveAttribute("tabindex", "-1");
  expect(ui.part("reading")).toHaveAttribute("role", "status");
  expect(ui.part("reading")).toHaveTextContent("Reading the history.");
  await act(async () => { pending.resolve(reply(historyThree)); });
  expect(ui.root).toHaveAttribute("data-state", "ready");
  expect(ui.paths()).toEqual([["GET", historyPath]]);
  expect(ui.labels()).toEqual(firstThreeLabels);
  expect(selectParts(ui.root, "version")).toHaveLength(3);
  expect(part(ui.row(0), "version-date")).toHaveTextContent("23 Oct 2026 16:12");
  expect(part(ui.row(0), "version-source")).toHaveTextContent("Sent");
  expect(part(ui.row(0), "version-words")).toHaveTextContent("3 words");
  expect(selectParts(ui.root, "in-book")).toEqual([part(ui.row(0), "in-book")]);
  expect(part(ui.row(0), "in-book")).toHaveTextContent("In Book");
  expect(ui.openRows().every((button) => button.getAttribute("aria-expanded") === "false")).toBe(true);
  expect(ui.part("version-detail")).toBeNull();
  ui.unmount();

  for (const history of [historyNoActive, { ...historyThree, active_version_id: "missing" }, historyNone]) {
    ui = reads(reply(history));
    await ui.state();
    expect(ui.part("in-book")).toBeNull();
    if (history.versions.length === 0) {
      expect(ui.part("empty")).toHaveTextContent("No versions yet.");
      expect(ui.part("version-list")).toBeNull();
    }
    ui.unmount();
  }

  ui = reads(reply({ ...historyNone, versions: [{ ...histA, at: "bad" }] }));
  await ui.state();
  expect(part(ui.row(0), "version-date")).toBeEmptyDOMElement();
  expect(ui.labels()).toEqual(["Saved, 2 words"]);
  ui.unmount();

  const retry = deferred<ReturnType<typeof reply>>();
  ui = reads((_, n) => n === 0 ? internalEnvelope : retry.promise);
  await ui.state("failed");
  expect(ui.part("read-failure")).toHaveAttribute("role", "status");
  expect(ui.part("read-failure")).toHaveTextContent("The history could not be read.");
  fireEvent.click(ui.part("try-again"));
  expect(ui.root).toHaveFocus();
  expect(ui.root).toHaveAttribute("data-state", "loading");
  expect(ui.count(historyPath)).toBe(2);
  await act(async () => { retry.resolve(reply(historyTwo)); });
  expect(ui.root).toHaveAttribute("data-state", "ready");
  expect(ui.openRows()).toHaveLength(2);
});

test("AC2 expands only the selected row, renders at most three text blocks and reuses cached previews", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  const ui = reads(reply(historyFour),
    version(histB.id, () => pending.promise), version(histC.id, reply(versionTextC)),
    version(histD.id, reply(versionTextD)), version(histA.id, reply({ ...versionTextA, blocks: [] })));
  await ui.state();
  const [d, c, b, a] = ui.openRows();
  fireEvent.click(b);
  expect(b).toHaveFocus();
  expect(b).toHaveAttribute("aria-expanded", "true");
  expect(ui.part("version-detail")).toHaveAttribute("data-state", "loading");
  expect(ui.part("version-reading")).toHaveAttribute("role", "status");
  expect(ui.part("version-reading")).toHaveTextContent("Reading this version.");
  expect(ui.count(versionPath(histB.id))).toBe(1);
  await act(async () => { pending.resolve(reply(versionTextB)); });
  expect(ui.part("version-detail")).toHaveAttribute("data-state", "ready");
  expect(ui.lines()).toEqual(["Title", "One", "Two"]);
  await act(async () => { fireEvent.click(c); });
  expect(b).toHaveAttribute("aria-expanded", "false");
  expect(c).toHaveAttribute("aria-expanded", "true");
  expect(part(b.parentElement!, "version-detail")).toBeNull();
  expect(ui.count(versionPath(histC.id))).toBe(1);
  fireEvent.click(c);
  expect(ui.part("version-detail")).toBeNull();
  fireEvent.click(b);
  expect(ui.lines()).toEqual(["Title", "One", "Two"]);
  expect(ui.count(versionPath(histB.id))).toBe(1);
  await act(async () => { fireEvent.click(d); });
  expect(ui.lines()).toEqual(["Title", "One", "Two!"]);
  await act(async () => { fireEvent.click(a); });
  expect(ui.part("no-text")).toHaveTextContent("This version has no text.");
  expect(ui.lines()).toEqual([]);
});

test("AC3 ignores late selections, deduplicates in-flight reads and retries failures with focus", async () => {
  const older = deferred<ReturnType<typeof reply>>();
  const retry = deferred<ReturnType<typeof reply>>();
  let ui = reads(reply(historyThree),
    version(histB.id, () => older.promise), version(histC.id, reply(versionTextC)),
    version(histA.id, (_, n) => n === 0 ? internalEnvelope : retry.promise));
  await ui.state();
  fireEvent.click(ui.row(1));
  await act(async () => { fireEvent.click(ui.row(0)); });
  await act(async () => { older.resolve(reply(versionTextB)); });
  expect(ui.lines()).toEqual(["Title", "One", "Two!"]);
  expect(part(ui.row(1).parentElement!, "version-detail")).toBeNull();
  fireEvent.click(ui.row(1));
  expect(ui.lines()).toEqual(["Title", "One", "Two"]);
  expect(ui.count(versionPath(histB.id))).toBe(1);
  expect(ui.count(versionPath(histC.id))).toBe(1);

  await act(async () => { fireEvent.click(ui.row(2)); });
  expect(ui.part("version-detail")).toHaveAttribute("data-state", "failed");
  expect(ui.part("version-failure")).toHaveAttribute("role", "status");
  expect(ui.part("version-failure")).toHaveTextContent("This version could not be read.");
  fireEvent.click(ui.part("version-try-again"));
  expect(ui.row(2)).toHaveFocus();
  expect(ui.part("version-detail")).toHaveAttribute("data-state", "loading");
  expect(ui.count(versionPath(histA.id))).toBe(2);
  await act(async () => { retry.resolve(reply(versionTextA)); });
  expect(ui.lines()).toEqual(["Title", "One"]);
  ui.unmount();

  const rejected = deferred<ReturnType<typeof reply>>();
  ui = reads(reply(historyThree), version(histC.id, reply(versionTextC)),
    version(histB.id, (_, n) => n === 0 ? rejected.promise : reply(versionTextB)));
  await ui.state();
  fireEvent.click(ui.row(1));
  fireEvent.click(ui.row(0));
  fireEvent.click(ui.row(1));
  expect(ui.count(versionPath(histB.id))).toBe(1);
  await act(async () => { fireEvent.click(ui.row(0)); });
  await act(async () => { rejected.resolve(reply(versionTextC)); });
  expect(ui.lines()).toEqual(["Title", "One", "Two!"]);
  expect(part(ui.row(1).parentElement!, "version-detail")).toBeNull();
  await act(async () => { fireEvent.click(ui.row(1)); });
  expect(ui.count(versionPath(histB.id))).toBe(2);
  expect(ui.lines()).toEqual(["Title", "One", "Two"]);
});

test("AC4 refreshes silently, keeps the selection and cache, and accepts only the latest list reply", async () => {
  const firstRefresh = deferred<ReturnType<typeof reply>>();
  const olderRefresh = deferred<ReturnType<typeof reply>>();
  let ui = reads((_, n) => {
    switch (n) {
      case 0: return reply(historyThree);
      case 1: return firstRefresh.promise;
      case 2: return internalEnvelope;
      case 3: return reply(historyFour);
      case 4: return olderRefresh.promise;
      default: return reply(historyNone);
    }
  }, version(histB.id, reply(versionTextB)));
  await ui.state();
  await act(async () => { fireEvent.click(ui.row(1)); });
  expect(ui.lines()).toEqual(["Title", "One", "Two"]);
  ui.update(1);
  expect(ui.count(historyPath)).toBe(2);
  expect(ui.root).toHaveAttribute("data-state", "ready");
  expect(ui.labels()).toEqual(firstThreeLabels);
  await act(async () => { firstRefresh.resolve(reply(historyFour)); });
  expect(ui.labels()).toEqual([
    "24 Oct 2026 10:00, Sent again, 5 words, In Book", "23 Oct 2026 16:12, Sent, 3 words",
    ...firstThreeLabels.slice(1),
  ]);
  expect(ui.row(2)).toHaveAttribute("aria-expanded", "true");
  expect(ui.lines()).toEqual(["Title", "One", "Two"]);
  expect(ui.count(versionPath(histB.id))).toBe(1);
  ui.update(1);
  expect(ui.count(historyPath)).toBe(2);
  await act(async () => { ui.update(2); });
  expect(ui.root).toHaveAttribute("data-state", "ready");
  expect(ui.openRows()).toHaveLength(4);
  expect(ui.part("refresh-failure")).toHaveAttribute("role", "status");
  expect(ui.part("refresh-failure")).toHaveTextContent("The history could not be refreshed.");
  fireEvent.click(ui.part("refresh-again"));
  expect(ui.root).toHaveFocus();
  expect(ui.part("refresh-failure")).toBeNull();
  expect(ui.count(historyPath)).toBe(4);
  await act(async () => {});
  expect(ui.openRows()).toHaveLength(4);

  ui.update(3);
  await act(async () => { ui.update(4); });
  await act(async () => { olderRefresh.resolve(reply(historyThree)); });
  expect(ui.part("empty")).toHaveTextContent("No versions yet.");
  expect(ui.part("version-detail")).toBeNull();
  ui.unmount();

  const blocking = deferred<ReturnType<typeof reply>>();
  ui = reads((_, n) => n === 0 ? internalEnvelope : blocking.promise);
  await ui.state("failed");
  ui.update(1);
  expect(ui.root).toHaveAttribute("data-state", "loading");
  expect(ui.count(historyPath)).toBe(2);
  ui.unmount();
  await act(async () => { blocking.resolve(reply(historyFour)); });
  expect(ui.container).toBeEmptyDOMElement();
});
