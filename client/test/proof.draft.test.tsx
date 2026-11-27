import { receiptPath, receiptRoute, workingRead, writeResult } from "./writeFixtures";
import type { WriteResult } from "../src/api/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { EditorView } from "prosemirror-view";
import { App } from "../src/App";
import type { VersionDetail } from "../src/api/types";
import { chapterA as listA, chaptersPath, mockApi, seriesA, seriesPath, treeA } from "./helpers";
import { a, b, chapterList, chapterPath, detailEmpty, hash, reply, verRow } from "./d06.fixtures";

// Observe the real Editor's ready hook without replacing any product behavior.
const capture = vi.hoisted(() => ({ view: null as EditorView | null }));
vi.mock("../src/editor/Editor", async (importOriginal) => {
  const { Editor } = await importOriginal<typeof import("../src/editor/Editor")>();
  return { Editor: (props: Parameters<typeof Editor>[0]) => <Editor {...props} onReady={view => { capture.view = view; props.onReady?.(view); }} /> };
});

test("AXB-0042 AC2: Send commits version and activation, loses reply and is reconciled without duplication", async () => {
  capture.view = null;
  let receipt: WriteResult;
  const versions: VersionDetail[] = [detailEmpty.version!]; const activations: string[] = [];
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: reply({ series: [seriesA] }) },
    { method: "GET", path: `${seriesPath}/${seriesA.id}`, reply: reply(treeA) },
    { method: "GET", path: chaptersPath, reply: () => chapterList([{ ...listA, version_id: versions.at(-1)!.id, active_version_id: activations.at(-1) ?? null, word_count: versions.length === 1 ? 0 : 1 }]) },
    workingRead(chapterPath, () => reply({ ...detailEmpty, version: versions.at(-1), active_version_id: activations.at(-1) ?? null,
      blocks: versions.length === 1 ? [] : [{ block_uid: "b_00000000000a", ordinal: 1, kind: "paragraph", text: versions.at(-1)!.content, hash }] })),
    { method: "POST", path: `${chapterPath}/send`, reply: (call) => {
      expect(call.body).toMatchObject({ content: "Hello", parent_version: a, base_version: a, base_revision: 0 });
      versions.push({ ...verRow(b, 2, a), source: "send", content: (call.body as { content: string }).content });
      activations.push(b);
      receipt = writeResult(call, { chapter: detailEmpty.chapter, version: verRow(b, 2, a), active_version_id: b });
      return "network";
    } },
    { method: "GET", path: receiptRoute, reply: () => reply({ receipt }) },
  ]);
  const { container } = render(<App />); fireEvent.click(await screen.findByRole("button", { name: "Open Chapter 1" }));
  const draft = await waitFor(() => { const el = container.querySelector('[data-surface="draft"]')!; expect(el).toHaveAttribute("data-state", "clean"); return el; });
  expect(capture.view).not.toBeNull(); const view = capture.view!;
  act(() => view.dispatch(view.state.tr.insertText("Hello", 1)));
  fireEvent.click(draft.querySelector('[data-part="send"]')!);
  await waitFor(() => {
    expect(draft).toHaveAttribute("data-state", "clean");
    expect(draft.querySelector('[data-part="write-failure"]')).toBeNull();
    expect(draft.querySelector('[data-part="send"]')).toHaveAttribute("aria-disabled", "true");
    expect(container.querySelector('[data-part="chapter"] [data-part="chip"]')).toBeNull();
    expect(container.querySelector('[data-part="chapter"] [data-part="count"]')).toHaveTextContent("1");
  });
  expect(versions).toHaveLength(2); expect(activations).toEqual([b]);
  expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual([`${chapterPath}/send`]);
  const index = calls.findIndex(c => c.method === "POST");
  expect(calls.slice(index + 1).map(c => [c.method, c.path])).toEqual([["GET", receiptPath(chapterPath, receipt!.request_id)], ["GET", chaptersPath]]);
});
