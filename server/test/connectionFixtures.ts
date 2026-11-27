import { readFileSync } from "node:fs";
import type { BookRow, SeriesRow } from "../src/series/repo.js";
// The browser and injected-server halves consume the same checked-in trace.
export const { origin, service, series, book, expectedTrace } = JSON.parse(
  readFileSync(new URL("../../client/test/connectionFixture.json", import.meta.url), "utf8"),
) as {
  origin: string; service: string; series: SeriesRow; book: BookRow;
  expectedTrace: { path: string; status: number; origin: string; body: unknown }[];
};
