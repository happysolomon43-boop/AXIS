import { expect, test } from "vitest";
import { chooseComparePair } from "../src/history/comparePair";

test("AC1 chooses the first distinct peer in History order without changing the catalogue", () => {
  const ids = Object.freeze(["V3", "V2", "V1"]);
  expect(chooseComparePair(ids, "V1")).toEqual({ a: "V1", b: "V3" });
  expect(chooseComparePair(ids, "V3")).toEqual({ a: "V3", b: "V2" });
  expect(ids).toEqual(["V3", "V2", "V1"]);
});

test("AC2 admits a singleton and refuses a missing selection", () => {
  expect(chooseComparePair(["V2"], "V2")).toEqual({ a: "V2", b: null });
  expect(chooseComparePair([], "V2")).toBeNull();
  expect(chooseComparePair(["V2"], "V1")).toBeNull();
});
