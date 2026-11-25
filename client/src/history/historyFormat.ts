import type { VersionBlock } from "../api/types";
import { formatWordCount } from "../binder/format";
import { copy } from "../copy";

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const sources = new Map([
  ["draft_edit", copy["history.source.draft_edit"]],
  ["send", copy["history.source.send"]],
  ["reupload", copy["history.source.reupload"]],
  ["restore", copy["history.source.restore"]],
  ["import", copy["history.source.import"]],
  ["bulk_replace", copy["history.source.bulk_replace"]],
  ["checkpoint", copy["history.source.checkpoint"]],
]);

export function formatVersionDate(at: string, timeZone?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";

  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone, day: "numeric", month: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const { day, month, year, hour, minute } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const monthName = months[Number(month) - 1];
    if (!day || !monthName || !year || !hour || !minute) return "";
    return `${Number(day)} ${monthName} ${year} ${hour}:${minute}`;
  } catch (error) {
    if (error instanceof RangeError && timeZone !== undefined) return formatVersionDate(at);
    return "";
  }
}

export function sourceWord(source: string): string {
  return sources.get(source) ?? copy["history.source.unknown"];
}

export function wordsLabel(count: number): string {
  return `${formatWordCount(count)} ${count === 1 ? "word" : "words"}`;
}

export function previewBlocks(blocks: VersionBlock[]): string[] {
  const lines: string[] = [];
  for (const { kind, text } of blocks) {
    if (kind !== "paragraph" && kind !== "heading") continue;
    lines.push(text);
    if (lines.length === 3) break;
  }
  return lines;
}
