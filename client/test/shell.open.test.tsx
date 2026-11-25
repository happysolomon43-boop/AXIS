import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Shell } from "../src/shell/Shell";
import { chaptersPath, mockApi, treeA } from "./helpers";
import { chapterList, chapterPath, detailText, fourRows, reply } from "./d06.fixtures";
import { noDraftRead, draftPath } from "./draftFixtures";

function chapterCalls(calls: import("./helpers").Call[]) {
  return calls.filter(({ method, path }) => method !== "GET" || path !== draftPath);
}

test("AXB-0041 AC4 hosts the real Draft, reads once and ignores reopening the current chapter", async () => {
  const { calls: allCalls } = mockApi([noDraftRead, { method: "GET", path: chaptersPath, reply: chapterList([fourRows[0]]) }, { method: "GET", path: chapterPath, reply: reply(detailText) }]);
  const calls = () => chapterCalls(allCalls);
  const { container } = render(<Shell tree={treeA} />); const region = container.querySelector('[data-region="text"]')!;
  expect(region).toBeEmptyDOMElement();
  const open = await screen.findByRole("button", { name: "Open Chapter 1: Title" }); fireEvent.click(open);
  await waitFor(() => expect(region.querySelector('[data-surface="draft"]')).toHaveAttribute("data-state", "clean"));
  expect(calls().map(c => c.path)).toEqual([chaptersPath, chapterPath]); fireEvent.click(open); expect(calls()).toHaveLength(2);
});
