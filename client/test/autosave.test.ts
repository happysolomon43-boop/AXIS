import { expect, test } from "vitest";
import { AUTOSAVE, fireAt } from "../src/draft/autosave";

test("AC1 schedules idle, hard deadline, minimum gap and retry after failure", () => {
  expect(AUTOSAVE).toEqual({ idleMs: 2000, minGapMs: 5000, hardMs: 30000 });
  for (const [lastChangeAt, dirtySince, lastPutStartAt, failedAt, expected] of [
    [10000, 10000, null, null, 12000],
    [39900, 10000, null, null, 40000],
    [10500, 10500, 10000, null, 15000],
    [10000, 10000, 9000, 20000, 50000],
    [21000, 21000, 19000, 20000, 24000],
  ] as const) {
    expect(fireAt({ lastChangeAt, dirtySince, lastPutStartAt, failedAt })).toBe(expected);
  }
});
