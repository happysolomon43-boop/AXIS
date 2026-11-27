import { workingRead, writeResponse } from "./writeFixtures";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EditorView } from "prosemirror-view";
import { afterEach, expect, test, vi } from "vitest";
import { Shell } from "../src/shell/Shell";
import { chapterList, chapterPath, detailText, fourRows, reply, writtenC } from "./d06.fixtures";
import { advance, draftNone, edit, fakeClock, putOk } from "./draftFixtures";
import { chaptersPath, deferred, mockApi, treeA } from "./helpers";
import { historyPath, historyThree, historyTwo } from "./historyFixtures";

const captured = vi.hoisted(() => ({ view: null as EditorView | null }));
vi.mock("../src/editor/Editor", async (importOriginal) => {
  const { Editor } = await importOriginal<typeof import("../src/editor/Editor")>();
  return { Editor: (props: Parameters<typeof Editor>[0]) => (
    <Editor {...props} onReady={(view) => {
      captured.view = view;
      props.onReady?.(view);
    }} />
  ) };
});

afterEach(() => vi.useRealTimers());

type Handler = Parameters<typeof mockApi>[0][number];

function mount({ secondChapter = false, history = reply(historyTwo), extra = [] }: {
  secondChapter?: boolean; history?: Handler["reply"]; extra?: Handler[];
} = {}) {
  captured.view = null;
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: chapterList(fourRows.slice(0, secondChapter ? 2 : 1)) },
    workingRead(chapterPath, reply(detailText), reply(draftNone)),
    { method: "GET", path: historyPath, reply: history },
    ...extra,
  ]);
  const { container } = render(<Shell tree={treeA} />);
  const part = (name: string) => container.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const region = (name: string) => container.querySelector<HTMLElement>(`[data-region="${name}"]`)!;
  const surface = (name: string) => container.querySelector<HTMLElement>(`[data-surface="${name}"]`)!;
  return {
    container, calls, part, region, surface,
    door: () => part("history-door"),
    drawer: () => region("drawer"),
    rows: () => surface("history").querySelectorAll('[data-part="version"]'),
    readCount: (path = historyPath) => calls.filter((call) => call.method === "GET" && call.path === path).length,
    open: async (name = "Open Chapter 1: Title") => {
      fireEvent.click(await screen.findByRole("button", { name }));
      await waitFor(() => expect(surface("draft")).toHaveAttribute("data-state", "clean"));
    },
    loaded: () => waitFor(() => expect(surface("history")).toHaveAttribute("data-state", "ready")),
  };
}

test("AC1 opens History from the strip while the Draft is locked and editable", async () => {
  const ui = mount();
  expect(ui.door()).toBeNull();
  expect(ui.drawer()).toBeNull();
  await ui.open();
  expect(ui.region("top-strip").lastElementChild).toBe(ui.door());
  expect(ui.door()).toHaveTextContent("History");
  expect(ui.door()).toHaveAttribute("aria-expanded", "false");
  expect(ui.drawer()).toBeNull();
  expect(ui.readCount()).toBe(0);

  fakeClock();
  edit(captured.view!);
  await act(async () => { fireEvent.click(ui.door()); });
  const drawer = ui.drawer();
  expect(ui.door()).toHaveAttribute("aria-expanded", "true");
  expect(ui.container.querySelectorAll('[data-region="drawer"]')).toHaveLength(1);
  expect(ui.region("text").nextElementSibling).toBe(drawer);
  expect(ui.part("drawer-title")).toHaveTextContent("Version history");
  expect(ui.part("drawer-close")).toHaveTextContent("Close");
  expect(drawer).toHaveAttribute("aria-label", "Version history");
  expect(drawer).not.toHaveAttribute("aria-modal");
  expect(drawer).toHaveFocus();
  expect(ui.part("drawer-body")).toContainElement(ui.surface("history"));
  expect(ui.surface("history")).toHaveAttribute("data-state", "ready");
  expect(ui.rows()).toHaveLength(2);
  expect(ui.readCount()).toBe(1);
  expect(ui.surface("draft")).toHaveAttribute("data-state", "unsaved");
  expect(ui.part("editor")).toHaveAttribute("contenteditable", "true");
  expect(ui.part("editor")).toHaveTextContent("Two!");
  expect(ui.part("chapter-open")).toHaveAttribute("aria-disabled", "true");
  expect(ui.calls.every(({ method }) => method === "GET")).toBe(true);
});

test("AC2 closes from Close, Escape within the Drawer, or the door and restores focus", async () => {
  const pending = deferred<ReturnType<typeof reply>>();
  const ui = mount({ history: (_, n) => n === 0 ? pending.promise : reply(historyTwo) });
  await ui.open();
  const door = ui.door();
  const close = [
    () => fireEvent.click(ui.part("drawer-close")),
    () => fireEvent.keyDown(ui.part("drawer-title"), { key: "Escape" }),
    () => fireEvent.click(door),
  ];
  for (const [index, action] of close.entries()) {
    await act(async () => { fireEvent.click(door); });
    expect(ui.readCount()).toBe(index + 1);
    expect(ui.drawer()).toHaveFocus();
    fireEvent.keyDown(ui.region("text"), { key: "Escape" });
    expect(ui.drawer()).toBeInTheDocument();
    action();
    expect(ui.drawer()).toBeNull();
    expect(door).toHaveAttribute("aria-expanded", "false");
    expect(door).toHaveFocus();
    if (index === 0) await act(async () => { pending.resolve(reply(historyThree)); });
  }
  await act(async () => { fireEvent.click(door); });
  expect(ui.readCount()).toBe(4);
  expect(ui.drawer()).toHaveFocus();
  expect(ui.rows()).toHaveLength(2);
});

test("AC3 preserves the Drawer on chapter switches and refreshes only after a version lands", async () => {
  const pathB = "/api/chapters/ch_00000000000b";
  const historyB = `${pathB}/history`;
  const ui = mount({ secondChapter: true, extra: [
    workingRead(pathB, reply({ ...detailText, chapter: { ...detailText.chapter, id: "ch_00000000000b" }, version: { ...detailText.version!, chapter_id: "ch_00000000000b" } })),
    { method: "GET", path: historyB, reply: (_, n) => reply((() => { const h=n===0?historyTwo:historyThree;return {...h,chapter:{...h.chapter,id:"ch_00000000000b"},versions:h.versions.map(v=>({...v,chapter_id:"ch_00000000000b"}))}; })()) },
    { method: "PUT", path: `${pathB}/draft`, reply: reply({ ...putOk(1), chapter: { ...detailText.chapter, id: "ch_00000000000b" } }) },
    { method: "POST", path: `${pathB}/versions`, reply: (call) => writeResponse(call, reply({ ...writtenC(null), chapter: { ...detailText.chapter, id: "ch_00000000000b" }, version: { ...writtenC(null).version, chapter_id: "ch_00000000000b" } }, 201)) },
  ] });
  await ui.open();
  fireEvent.click(ui.door());
  await ui.loaded();
  const drawer = ui.drawer();
  const oldHistory = ui.surface("history");
  await ui.open("Open Chapter 2");
  await ui.loaded();
  expect(ui.drawer()).toBe(drawer);
  expect(ui.surface("history")).not.toBe(oldHistory);
  expect(ui.door()).toHaveAttribute("aria-expanded", "true");
  expect(ui.part("editor")).toHaveFocus();
  expect(ui.readCount(historyB)).toBe(1);
  expect(ui.readCount()).toBe(1);

  fakeClock();
  edit(captured.view!);
  await advance(2000);
  expect(ui.surface("draft")).toHaveAttribute("data-autosave", "saved");
  expect(ui.calls.filter(({ method, path }) => method === "PUT" && path === `${pathB}/draft`)).toHaveLength(1);
  expect(ui.readCount(historyB)).toBe(1);
  await act(async () => { fireEvent.click(ui.part("save")); });
  expect(ui.calls.filter(({ method, path }) => method === "POST" && path === `${pathB}/versions`)).toHaveLength(1);
  expect(ui.readCount(historyB)).toBe(2);
  expect(ui.readCount()).toBe(1);
  expect(ui.rows()).toHaveLength(3);
});
