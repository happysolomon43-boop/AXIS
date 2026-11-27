import type { BookRow, SeriesRow } from "../src/api/types";
import raw from "./connectionFixture.json?raw";
export const { origin, service, series, book, expectedTrace } = JSON.parse(raw) as {
  origin: string; service: string; series: SeriesRow; book: BookRow;
  expectedTrace: { path: string; status: number; origin: string; body: unknown }[];
};
