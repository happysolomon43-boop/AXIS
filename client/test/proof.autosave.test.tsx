import { workingPath, workingRead } from "./writeFixtures";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/App";
import type { ChapterDetail, DraftDetail, DraftHead, VersionDetail } from "../src/api/types";
import { a, chapterList, chapterPath, detailText, reply, verRow } from "./d06.fixtures";
import { advance, chapterA, draftPath, edit, fakeClock } from "./draftFixtures";
import { chapterA as binderChapter, chaptersPath, mockApi, seriesA, seriesPath, treeA } from "./helpers";

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

test("AXB-0050 AC2 adopts the stored draft after a lost PUT reply without writing a version", async () => {
  const versions: VersionDetail[] = [{ ...verRow(a, 1, null), content: "# Title\n\nOne" }];
  const stored: DraftDetail = { chapter: chapterA, draft: null };
  const edited = "# Title\n\nOne!";
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: reply({ series: [seriesA] }) },
    { method: "GET", path: `${seriesPath}/${seriesA.id}`, reply: reply(treeA) },
    { method: "GET", path: chaptersPath, reply: chapterList([{ ...binderChapter, title: "Title", word_count: 2, version_id: a }]) },
    workingRead(chapterPath, () => reply({
      ...detailText, version: versions.at(-1)!, blocks: detailText.blocks.slice(0, 2), scenes: [],
    } satisfies ChapterDetail), () => reply(stored)),
    { method: "PUT", path: draftPath, reply: (call, n) => {
      const { content, base_version, base_revision } = call.body as Pick<DraftHead, "content" | "base_version"> & { base_revision: number };
      const current_version = versions.at(-1)!.id;
      const current_revision = stored.draft?.revision ?? 0;
      if (base_version !== current_version || base_revision !== current_revision) {
        return reply({ error: {
          code: "conflict", message: "Draft is out of date",
          details: { reason: base_version !== current_version ? "version" : "revision", current_version, current_revision },
        } }, 409);
      }
      const blocks = [
        { ordinal: 1, kind: "heading", text: "Title" },
        { ordinal: 2, kind: "paragraph", text: content.slice("# Title\n\n".length) },
      ] satisfies DraftHead["blocks"];
      stored.draft = { base_version, revision: base_revision + 1, content, blocks };
      return n === 0 ? "network" : reply({ chapter: chapterA, base_version, revision: stored.draft.revision });
    } },
    { method: "POST", path: /\/(versions|send)$/, reply: (call) => {
      const { content } = call.body as { content: string };
      const version = { ...verRow("ver_00000000000b", 2, a), content };
      versions.push(version);
      return reply({ chapter: chapterA, version, active_version_id: null }, 201);
    } },
  ]);

  const { container } = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Chapter 1: Title" }));
  const draft = container.querySelector('[data-surface="draft"]')!;
  await waitFor(() => expect(draft).toHaveAttribute("data-state", "clean"));
  fakeClock();
  edit(editor.view!);
  expect(screen.getByRole("button", { name: "Open Chapter 1: Title" })).toHaveAttribute("aria-disabled", "true");
  await advance(2000);
  expect(draft).toHaveAttribute("data-autosave", "failed");
  expect(stored.draft?.revision).toBe(1);

  await advance(30000);

  const draftCalls = calls.filter(({ path }) => path === draftPath || path === workingPath(chapterPath));
  expect(draftCalls.map(({ method }) => method)).toEqual(["GET", "PUT", "PUT", "GET"]);
  const input = { content: edited, base_version: a, base_revision: 0 };
  expect(draftCalls[1].body).toEqual(input);
  expect(draftCalls[2].body).toEqual(input);
  expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);
  expect(stored.draft).toMatchObject({ base_version: a, content: edited, revision: 1 });
  expect(versions).toHaveLength(1);
  expect(draft).toHaveAttribute("data-autosave", "saved");
  expect(draft).toHaveAttribute("data-state", "unsaved");
  expect(draft.querySelector('[data-part="conflict"]')).toBeNull();
  for (const button of container.querySelectorAll('[data-part="chapter-open"]')) {
    expect(button).toHaveAttribute("aria-disabled", "false");
  }
  expect(screen.getByRole("button", { name: "Open Chapter 1: Title" })).toHaveAttribute("aria-disabled", "false");
});
