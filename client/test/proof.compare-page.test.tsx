import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TextSelection } from "prosemirror-state";
import { expect, test, vi } from "vitest";
import { Shell } from "../src/shell/Shell";
import { head, ok, proofRoutes, rawV2, text, textPath, v1, v2, v3 } from "./d20Fixtures";
import { compareEntry, liveView, openDraft, recordEditor } from "./d20Ui";
import { deferred, mockApi, treeA } from "./helpers";

vi.mock("../src/editor/Editor", async (original) => {
  const { Editor } = await original<typeof import("../src/editor/Editor")>();
  return { Editor: (props: Parameters<typeof Editor>[0]) => <Editor {...props} onReady={view => {
    recordEditor(view);
    props.onReady?.(view);
  }} /> };
});

vi.mock("../src/history/historyFormat", async (original) => {
  const formats = await original<typeof import("../src/history/historyFormat")>();
  return { ...formats, formatVersionDate: (at: string, zone = "UTC") => formats.formatVersionDate(at, zone) };
});

test("AXB-0151 one delayed V1 response cannot overwrite the accepted V2/V3 pair or move the live Draft", async () => {
  const delayed = deferred<ReturnType<typeof ok>>();
  const { calls } = mockApi([...proofRoutes,
    { method: "GET", path: textPath(v1), reply: () => delayed.promise },
    { method: "GET", path: textPath(v2), reply: ok(text(v2)) },
    { method: "GET", path: textPath(v3), reply: ok(text(v3)) },
  ]);
  const ui = render(<Shell tree={treeA} />);
  try {
    const view = await openDraft(ui.container);
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5))));
    const { selection, doc } = view.state;
    fireEvent.click(await compareEntry(ui.container));
    const sideA = screen.getByRole("combobox", { name: "Version A" });
    expect(sideA).toHaveValue(v1);
    await waitFor(() => expect(calls.filter(call => call.path.endsWith("/text")).map(call => call.path)).toEqual([
      textPath(v1), textPath(v3),
    ]));
    fireEvent.change(sideA, { target: { value: v2 } });
    const regionA = await screen.findByRole("region", { name: "Text A" });
    const verifyPair = () => {
      expect(regionA.firstElementChild?.textContent).toBe(rawV2);
      expect(screen.getByRole("region", { name: "Text B" }).firstElementChild?.textContent).toBe("");
      for (const [side, id, label] of [["A", v2, "v2 · Sent · 16 Nov 2026 10:00"], ["B", v3, "v3 · Restored · 16 Nov 2026 11:00"]]) {
        const chip = screen.getByRole("group", { name: `Side ${side}` });
        expect(chip).toHaveAttribute("data-version-id", id);
        expect(chip.lastElementChild?.textContent).toBe(label);
      }
      expect(screen.queryByRole("alert")).toBeNull();
    };
    verifyPair();
    const total = calls.length;
    await act(async () => delayed.resolve(ok(text(v1))));
    verifyPair();
    expect(calls).toHaveLength(total);
    expect(calls.filter(call => call.path.endsWith("/text")).map(call => call.path)).toEqual([
      textPath(v1), textPath(v3), textPath(v2), textPath(v3),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Back to text/ }));
    expect(calls).toHaveLength(total);
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(liveView(ui.container)).toBe(view);
    expect(view.state.doc).toBe(doc);
    expect(view.state.doc.textContent).toBe(head);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(view.dom).toHaveFocus();
  } finally {
    ui.unmount();
    delayed.resolve(ok(text(v1)));
  }
});
