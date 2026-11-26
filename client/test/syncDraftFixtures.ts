import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { expect } from "vitest";
import type { ChapterDetail, ChapterSync } from "../src/api/types";
import { Shell } from "../src/shell/Shell";
import { chapterPath, detailText, reply } from "./d06.fixtures";
import { draftNone, draftPath } from "./draftFixtures";
import { chaptersPath, mockApi } from "./helpers";
import { historyPath, versionPath, versionTextB } from "./historyFixtures";
import { pbList, pbTree } from "./pullbackFixtures";
import { historyAfterRestore, historyH3, restorePath, restoreReply, rowB } from "./restoreFixtures";

export const syncDraftOnly = { state: "draft_only", same: false } satisfies ChapterSync;
export const syncInBook = { state: "in_book", same: true } satisfies ChapterSync;
export const syncEdited = { state: "edited", same: false } satisfies ChapterSync;
export const syncRevisedSame = { state: "being_revised", same: true } satisfies ChapterSync;
export const syncRevised = { state: "being_revised", same: false } satisfies ChapterSync;

export function withSync<T extends object>({ status, body }: { status: number; body: T }, sync: ChapterSync) {
  return { status, body: { ...body, sync } };
}

export const restoredText = "Restored text";
export const detailAfterRestore = {
  ...detailText,
  version: { ...detailText.version!, id: "ver_00000000000e", source: "restore", content: restoredText },
  blocks: [{ ...detailText.blocks[0], kind: "paragraph", text: restoredText }],
} satisfies ChapterDetail;

type RestoreRead = Parameters<typeof mockApi>[0][number]["reply"];

export async function mountRestore({
  chapter = reply(detailAfterRestore), head = withSync({ status: 200, body: draftNone }, syncInBook),
  initialSync = syncInBook, restore = restoreReply,
}: {
  chapter?: RestoreRead; head?: RestoreRead; initialSync?: ChapterSync; restore?: RestoreRead;
} = {}) {
  const chapterB = { ...detailText.chapter, id: pbList.chapters[1].id, order_key: "0000002000" };
  const pathB = "/api/chapters/" + chapterB.id;
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: reply(pbList) },
    { method: "GET", path: chapterPath, reply: (call, n) => n === 0 ? reply(detailText)
      : typeof chapter === "function" ? chapter(call, n - 1) : chapter },
    { method: "GET", path: draftPath, reply: (call, n) => n === 0 ? withSync({ status: 200, body: draftNone }, initialSync)
      : typeof head === "function" ? head(call, n - 1) : head },
    { method: "GET", path: historyPath, reply: (_, n) => reply(n === 0 ? historyH3 : historyAfterRestore) },
    { method: "GET", path: versionPath(rowB.id), reply: reply(versionTextB) },
    { method: "POST", path: restorePath, reply: restore },
    { method: "GET", path: pathB, reply: reply({
      ...detailText, chapter: chapterB, version: { ...detailText.version!, chapter_id: chapterB.id },
    }) },
    { method: "GET", path: pathB + "/draft", reply: reply({ chapter: chapterB, draft: null }) },
    { method: "GET", path: pathB + "/history", reply: reply({ chapter: chapterB, versions: [], active_version_id: null }) },
  ]);
  const ui = render(createElement(Shell, { tree: pbTree }));
  const root = () => ui.container.querySelector<HTMLElement>('[data-surface="draft"]')!;
  const part = (name: string, scope: ParentNode = ui.container) => scope.querySelector<HTMLElement>('[data-part="' + name + '"]')!;
  fireEvent.click(await screen.findByRole("button", { name: "Open Chapter 1" }));
  await waitFor(() => expect(root()).toHaveAttribute("data-state", "clean"));
  await act(async () => { fireEvent.click(part("history-door")); });
  const [, version] = ui.container.querySelectorAll('[data-part="version-open"]');
  await act(async () => { fireEvent.click(version); });
  expect(part("version-detail")).toHaveAttribute("data-state", "ready");
  return { ...ui, calls, root, part, pathB };
}
