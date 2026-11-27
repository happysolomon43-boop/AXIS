import { receiptPath, receiptRoute, workingPath, workingRead, writeResult } from "./writeFixtures";
import type { WriteResult } from "../src/api/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import { chapterList, chapterPath, detailText, fourRows, reply } from "./d06.fixtures";
import { edit, fakeClock } from "./draftFixtures";
import { chaptersPath, deferred, mockApi, seriesA, seriesPath, treeA } from "./helpers";
import { historyPath, versionPath, versionTextB } from "./historyFixtures";
import { historyAfterRestore, historyH3, restorePath, restoreReply, rowB } from "./restoreFixtures";

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

test("AXB-0065 AC2 recognizes the lost restore reply and preserves the writer's new edit", async () => {
  const post = deferred<"network">();
  const preview = versionPath(rowB.id);
  let written: WriteResult;
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: reply({ series: [seriesA] }) },
    { method: "GET", path: `${seriesPath}/${seriesA.id}`, reply: reply(treeA) },
    { method: "GET", path: chaptersPath, reply: chapterList([fourRows[0]]) },
    workingRead(chapterPath, reply(detailText)),
    { method: "GET", path: historyPath, reply: (_, n) => reply(n === 0 ? historyH3 : historyAfterRestore) },
    { method: "GET", path: preview, reply: reply(versionTextB) },
    { method: "POST", path: restorePath, reply: call => { written = writeResult(call, restoreReply.body); return post.promise; } },
    { method: "GET", path: receiptRoute, reply: () => reply({ receipt: written }) },
  ]);
  const { container } = render(<App />);
  const part = (name: string) => container.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const currentDraft = () => container.querySelector('[data-surface="draft"]');

  fireEvent.click(await screen.findByRole("button", { name: "Open Chapter 1: Title" }));
  await waitFor(() => expect(currentDraft()).toHaveAttribute("data-state", "clean"));
  const draft = currentDraft();
  const editorNode = part("editor");

  fakeClock();
  await act(async () => { fireEvent.click(part("history-door")); });
  const [, row] = container.querySelectorAll('[data-part="version-open"]');
  await act(async () => { fireEvent.click(row); });
  fireEvent.click(part("version-restore"));
  expect(part("version-actions")).toHaveAttribute("data-state", "restoring");
  expect(calls.filter(({ method }) => method === "POST")).toMatchObject([
    { method: "POST", path: restorePath, body: { version_id: rowB.id } },
  ]);

  edit(editor.view!);
  expect(draft).toHaveAttribute("data-state", "unsaved");
  expect(editorNode).toHaveTextContent("Two!");
  await act(async () => { post.resolve("network"); });

  expect(part("restore-status").textContent).toBe("Restored as a new version. The text in your draft was not replaced.");
  expect(part("restore-failure")).toBeNull();
  expect(currentDraft()).toBe(draft);
  expect(draft).toHaveAttribute("data-state", "unsaved");
  expect(draft).toHaveAttribute("data-autosave", "pending");
  expect(part("editor")).toBe(editorNode);
  expect(editorNode).toHaveTextContent("Two!");
  expect(part("chapter-open")).toHaveAttribute("aria-disabled", "true");
  expect(container.querySelectorAll('[data-part="version"]')).toHaveLength(4);
  expect(part("version-source")).toHaveTextContent(/^Restored$/);

  expect(calls.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
    `GET ${seriesPath}`, `GET ${seriesPath}/${seriesA.id}`,
    `GET ${chaptersPath}`, `GET ${chaptersPath}`, `GET ${workingPath(chapterPath)}`,
    `GET ${historyPath}`, `GET ${historyPath}`, `GET ${receiptPath(chapterPath, written!.request_id)}`, `GET ${preview}`, `POST ${restorePath}`,
  ].sort());
});
