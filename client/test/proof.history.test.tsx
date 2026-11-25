import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import { chapterList, chapterPath, detailText, fourRows, reply } from "./d06.fixtures";
import { draftPath, edit, fakeClock, noDraftRead } from "./draftFixtures";
import { chaptersPath, deferred, mockApi, seriesA, seriesPath, treeA } from "./helpers";
import { histA, histB, historyPath, historyTwo, versionPath, versionTextA, versionTextB } from "./historyFixtures";

const editor = vi.hoisted(() => ({ view: null as EditorView | null }));
vi.mock("../src/editor/Editor", async (importOriginal) => {
  const { Editor } = await importOriginal<typeof import("../src/editor/Editor")>();
  return { Editor: (props: Parameters<typeof Editor>[0]) => (
    <Editor {...props} onReady={(view) => {
      editor.view = view;
      props.onReady?.(view);
    }} />
  ) };
});

afterEach(() => vi.useRealTimers());

test("AXB-0058 AC2 keeps the selected version and unsaved Draft intact when another row replies late", async () => {
  const delayed = deferred<ReturnType<typeof reply>>();
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: reply({ series: [seriesA] }) },
    { method: "GET", path: `${seriesPath}/${seriesA.id}`, reply: reply(treeA) },
    { method: "GET", path: chaptersPath, reply: chapterList([fourRows[0]]) },
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    noDraftRead,
    { method: "GET", path: historyPath, reply: reply(historyTwo) },
    { method: "GET", path: versionPath(histB.id), reply: () => delayed.promise },
    { method: "GET", path: versionPath(histA.id), reply: reply(versionTextA) },
  ]);
  const { container } = render(<App />);
  const part = (name: string) => container.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const draft = () => container.querySelector('[data-surface="draft"]');
  const lines = () => Array.from(container.querySelectorAll('[data-part="preview-line"]'), (line) => line.textContent);
  fireEvent.click(await screen.findByRole("button", { name: "Open Chapter 1: Title" }));
  await waitFor(() => expect(draft()).toHaveAttribute("data-state", "clean"));
  fakeClock();
  edit(editor.view!);
  expect(draft()).toHaveAttribute("data-state", "unsaved");
  const typed = part("editor");
  expect(typed).toHaveTextContent("Two!");

  await act(async () => { fireEvent.click(part("history-door")); });
  const [b, a] = container.querySelectorAll('[data-part="version-open"]');
  fireEvent.click(b);
  expect(part("version-detail")).toHaveAttribute("data-state", "loading");
  await act(async () => { fireEvent.click(a); });
  expect(a).toHaveAttribute("aria-expanded", "true");
  expect(lines()).toEqual(["Title", "One"]);

  await act(async () => { delayed.resolve(reply(versionTextB)); });
  expect(a).toHaveAttribute("aria-expanded", "true");
  expect(b.parentElement?.querySelector('[data-part="version-detail"]')).toBeNull();
  expect(lines()).toEqual(["Title", "One"]);
  const numberOfCalls = calls.length;
  fireEvent.click(b);
  expect(calls).toHaveLength(numberOfCalls);
  expect(b).toHaveAttribute("aria-expanded", "true");
  expect(lines()).toEqual(["Title", "One", "Two"]);

  expect(calls.filter(({ path }) => path === chapterPath || path.startsWith(`${chapterPath}/`))
    .map(({ method, path }) => [method, path])).toEqual([
    ["GET", chapterPath], ["GET", draftPath], ["GET", historyPath],
    ["GET", versionPath(histB.id)], ["GET", versionPath(histA.id)],
  ]);
  expect(calls.every(({ method }) => method === "GET")).toBe(true);
  expect(draft()).toHaveAttribute("data-state", "unsaved");
  expect(draft()).toHaveAttribute("data-autosave", "pending");
  expect(part("editor")).toBe(typed);
  expect(typed).toHaveTextContent("Two!");
  expect(typed).toHaveAttribute("contenteditable", "true");
  const binderButtons = container.querySelectorAll('[data-part="chapter-open"]');
  expect(binderButtons).toHaveLength(1);
  for (const button of binderButtons) expect(button).toHaveAttribute("aria-disabled", "true");
});
