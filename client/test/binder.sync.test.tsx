import { render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ChapterSync } from "../src/api/types";
import { Binder } from "../src/binder/Binder";
import { syncChip, versionChip } from "../src/binder/format";
import { chaptersPath, mockApi } from "./helpers";
import { pbList, pbListAfterB, pbTree } from "./pullbackFixtures";

const labels = ["Draft only", null, "In Book, edited since upload", "Being revised, no changes yet", "Being revised"];
const legacy = [
  { ...pbList.chapters[0], sync: undefined },
  { ...pbList.chapters[1], sync: undefined },
  { ...pbList.chapters[2], sync: undefined, version_id: "ver_ffffffffffff" },
];

test("AXB-0071 AC1 formats all served states, unknown states and legacy items", () => {
  expect(pbList.chapters.map(syncChip)).toEqual(labels);
  expect(legacy.map(syncChip)).toEqual(legacy.map(versionChip));
  const unknown = { state: "unknown", same: false } as unknown as ChapterSync;
  expect(syncChip({ ...pbList.chapters[0], sync: unknown })).toBeNull();
});

test("AXB-0071 AC2 draws one chip per row, updating on refresh and supporting old replies", async () => {
  const replies = [pbList, pbListAfterB, { chapters: legacy }];
  const { calls } = mockApi([
    { method: "GET", path: chaptersPath, reply: (_, n) => ({ status: 200, body: replies[n] }) },
  ]);
  const { container, rerender } = render(<Binder tree={pbTree} />);
  const rows = () => [...container.querySelectorAll('[data-part="chapter"]')];
  const chipLabels = () => rows().map((row) => row.querySelector('[data-part="chip"]')?.textContent ?? null);
  await waitFor(() => expect(chipLabels()).toEqual(labels));
  expect(rows()[1].querySelector('[data-part="chip"]')).toBeNull();
  expect(container.querySelectorAll('[data-part="chip"]')).toHaveLength(4);

  rerender(<Binder tree={pbTree} refreshToken={1} />);
  await waitFor(() => expect(chipLabels()).toEqual([labels[0], labels[3], ...labels.slice(2)]));
  rerender(<Binder tree={pbTree} refreshToken={2} />);
  await waitFor(() => expect(chipLabels()).toEqual(legacy.map(versionChip)));
  expect(calls.map(({ method, path }) => [method, path])).toEqual(Array(3).fill(["GET", chaptersPath]));
});
