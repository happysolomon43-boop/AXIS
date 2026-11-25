import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import type { ChapterListItem } from "../src/api/types";
import { chapterA, chaptersPath, mockApi, seriesA, seriesPath, treeA } from "./helpers";

test("AXB-0034 AC2 recovers a lost chapter response without writing a second chapter", async () => {
  const originalFetch = globalThis.fetch;
  const stored: ChapterListItem[] = [];
  localStorage.setItem("axis.lastSeriesId", seriesA.id);
  const { calls } = mockApi([
    { method: "GET", path: seriesPath, reply: { status: 200, body: { series: [seriesA] } } },
    { method: "GET", path: `${seriesPath}/${seriesA.id}`, reply: { status: 200, body: treeA } },
    { method: "GET", path: chaptersPath, reply: () => ({ status: 200, body: { chapters: stored } }) },
    {
      method: "POST",
      path: chaptersPath,
      reply: () => {
        stored.push(chapterA);
        return "network";
      },
    },
  ]);

  try {
    render(<App />);
    const add = await screen.findByRole("button", { name: "Add the first scene" });
    await act(async () => { fireEvent.click(add); });

    const rows = screen.getAllByRole("listitem", { name: "Chapter 1" });
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("0")).toHaveAttribute("data-part", "count");
    expect(within(rows[0]).getByText("Draft only")).toHaveAttribute("data-part", "chip");
    expect(screen.queryByRole("button", { name: "Add the first scene" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stored).toEqual([chapterA]);
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(calls.slice(-2).map(({ method, path }) => [method, path]))
      .toEqual([["POST", chaptersPath], ["GET", chaptersPath]]);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
  expect(globalThis.fetch).toBe(originalFetch);
  expect(localStorage).toHaveLength(0);
});
