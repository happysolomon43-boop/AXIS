import { act, render, waitFor } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { createElement } from "react";
import { expect, vi } from "vitest";
import { Draft } from "../src/draft/Draft";
import tokens from "../src/styles/tokens.css?raw";
import type { ChapterDetail, DraftDetail, DraftWritten } from "../src/api/types";
import { b, c, d, chapterPath, detailText, reply, verRow } from "./d06.fixtures";
import { mockApi } from "./helpers";

export const chapterA = { id: "ch_00000000000a", book_id: "bk_00000000000a", order_key: "0000001000" };
export const draftPath = `/api/chapters/${chapterA.id}/draft`;
export const draftNone = { chapter: chapterA, draft: null } satisfies DraftDetail;

function head(base_version: string, revision: number, lastText: string) {
  return {
    chapter: chapterA,
    draft: {
      base_version, revision, content: `# Title\n\nOne\n\n---\n\n${lastText}`,
      blocks: [
        { ordinal: 1, kind: "heading", text: "Title" },
        { ordinal: 2, kind: "paragraph", text: "One" },
        { ordinal: 3, kind: "scene_break", text: "---" },
        { ordinal: 4, kind: "paragraph", text: lastText },
      ],
    },
  } satisfies DraftDetail;
}

export const draftHeadB = head(b, 1, "Two!");
export const draftHeadOther = head(b, 1, "Other");
export const draftHeadD = head(d, 2, "Two?");
export const putOk = (revision: number): DraftWritten => ({ chapter: chapterA, base_version: b, revision });
export const conflictEnvelope = reply({
  error: {
    code: "conflict",
    message: "Draft is out of date",
    details: { reason: "revision", current_version: b, current_revision: 1 },
  },
}, 409);
export const detailD: ChapterDetail = {
  ...detailText,
  chapter: chapterA,
  version: { ...verRow(d, 4, c), content: "# Title\n\nOne\n\n---\n\nTwo" },
  active_version_id: null,
};

export const noDraftRead = { method: "GET", path: draftPath, reply: reply(draftNone) };

type Handler = Parameters<typeof mockApi>[0][number];

export function mountDraft(
  { chapter = reply(detailText), draft = reply(draftNone), put, writes = [] }: {
    chapter?: Handler["reply"];
    draft?: Handler["reply"];
    put?: Handler["reply"];
    writes?: Handler[];
  } = {},
) {
  const { calls } = mockApi([
    { method: "GET", path: chapterPath, reply: chapter },
    { method: "GET", path: draftPath, reply: draft },
    ...(put === undefined ? [] : [{ method: "PUT", path: draftPath, reply: put }]),
    ...writes,
  ]);
  const onLockChange = vi.fn<(locked: boolean) => void>();
  const onWritten = vi.fn<() => void>();
  const onEditorReady = vi.fn<(view: EditorView) => void>();
  const { container, unmount } = render(createElement(Draft, {
    chapterId: chapterA.id, onLockChange, onWritten, onEditorReady,
  }));
  const root = container.querySelector<HTMLElement>('[data-surface="draft"]')!;
  function part<T extends HTMLElement = HTMLElement>(name: string) {
    return root.querySelector<T>(`[data-part="${name}"]`)!;
  }
  return {
    root, part, calls, onLockChange, onWritten, onEditorReady, unmount,
    async loaded(state = "clean") {
      await waitFor(() => expect(root).toHaveAttribute("data-state", state));
    },
    view() { return onEditorReady.mock.calls.at(-1)![0]; },
    blocks() {
      return Array.from(part("editor").querySelectorAll("[data-block]"), (el) => [el.getAttribute("data-block"), el.textContent]);
    },
    puts() { return calls.filter(({ method, path }) => method === "PUT" && path === draftPath); },
  };
}

export function edit(view: EditorView, text = "!") {
  act(() => view.dispatch(view.state.tr.insertText(text, view.state.doc.content.size - 1)));
}

export function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

export async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

export async function mountConflict({
  chapter = reply(detailText), reloadHead = reply(draftNone), writes, nextPut = reply(putOk(1)),
}: {
  chapter?: Handler["reply"];
  reloadHead?: Handler["reply"];
  writes?: Handler[];
  nextPut?: Handler["reply"];
} = {}) {
  const ui = mountDraft({
    chapter,
    draft: (call, n) => {
      if (n === 0) return reply(draftNone);
      if (n === 1) return reply(draftHeadOther);
      return typeof reloadHead === "function" ? reloadHead(call, n - 2) : reloadHead;
    },
    put: (call, n) => n === 0 ? conflictEnvelope : typeof nextPut === "function" ? nextPut(call, n) : nextPut,
    writes,
  });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  await advance(2000);
  return ui;
}

export function draftThemeColors() {
  const themeValues = {
    light: ["#ECEBE6", "#FCFCFA", "#1B1C1E", "#62656A", "#B42318"],
    dark: ["#0B0C0E", "#0E1012", "#D9D6CD", "#94938E", "#F2766B"],
    sepia: ["#D8CAAD", "#F6EEDD", "#2B2418", "#594F3D", "#A31F14"],
  };
  return Object.entries(themeValues).map(([name, expected]) => {
    const block = tokens.split(`:root[data-theme="${name}"] {`)[1]?.split("}")[0] ?? "";
    const colors = ["surface-shell", "surface-raised", "text-primary", "text-tertiary", "severity-break"]
      .map((token) => block.match(new RegExp(`--ax-color-${token}:\\s*(#[0-9A-Fa-f]{6});`))?.[1] ?? "");
    expect(colors, name).toEqual(expected);
    const [shell, raised, ink, tertiary, breakColor] = colors;
    return { name, shell, raised, ink, tertiary, breakColor };
  });
}

export function contrast(foreground: string, background: string) {
  function luminance(hex: string) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const a = luminance(foreground);
  const b = luminance(background);
  return Math.floor(10 * (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) / 10;
}
