import { expect, test } from "vitest";
import { formatVersionDate, previewBlocks, sourceWord, wordsLabel } from "../src/history/historyFormat";
import { versionTextD } from "./historyFixtures";

test("AC1 uses fixed English dates, 24-hour local time and the device zone fallback", () => {
  for (const [at, zone, expected] of [
    ["2026-10-23T16:12:00.000Z", "UTC", "23 Oct 2026 16:12"],
    ["2026-01-05T04:07:00.000Z", "UTC", "5 Jan 2026 04:07"],
    ["2026-03-01T00:00:00.000Z", "UTC", "1 Mar 2026 00:00"],
    ["2026-10-23T16:12:00.000Z", "Asia/Tokyo", "24 Oct 2026 01:12"],
    ["2026-10-23T16:12:00+02:00", "UTC", "23 Oct 2026 14:12"],
    ["not a date", "UTC", ""],
    ["", "UTC", ""],
  ]) {
    expect(formatVersionDate(at, zone)).toBe(expected);
  }
  const at = "2026-10-23T16:12:00.000Z";
  const local = formatVersionDate(at);
  expect(local).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}$/);
  expect(formatVersionDate(at, "Nowhere/Land")).toBe(local);
});

test("AC2 formats every source, groups whole counts and keeps up to three text blocks unchanged", () => {
  const sources = ["draft_edit", "send", "reupload", "restore", "import", "bulk_replace", "checkpoint", "weird", "", "__proto__"];
  expect(sources.map(sourceWord)).toEqual([
    "Saved", "Sent", "Sent again", "Restored", "Imported", "Bulk replace", "Checkpoint", "Version", "Version", "Version",
  ]);
  expect([0, 1, 2, 3380, 1234567].map(wordsLabel)).toEqual([
    "0 words", "1 word", "2 words", "3,380 words", "1,234,567 words",
  ]);
  expect(previewBlocks(versionTextD.blocks)).toEqual(["Title", "One", "Two!"]);
  expect(previewBlocks([{ ordinal: 1, kind: "scene_break", text: "---" }])).toEqual([]);
  expect(previewBlocks([])).toEqual([]);
  expect(previewBlocks([{ ordinal: 1, kind: "paragraph", text: "a\nb" }])).toEqual(["a\nb"]);
});
