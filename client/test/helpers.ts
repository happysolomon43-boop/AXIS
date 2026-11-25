import { vi } from "vitest";
import type { BookRow, ChapterCreated, ChapterListItem, SeriesRow, SeriesTree } from "../src/api/types";

export type Call = { method: string; path: string; headers: Headers; body: unknown };

type Reply = { status: number; body: unknown } | "network";
type Handler = {
  method: string;
  path: string | RegExp;
  reply: Reply | ((call: Call, n: number) => Reply | Promise<Reply>);
};

export function mockApi(handlers: Handler[]) {
  const calls: Call[] = [];
  const routes = handlers.map((handler) => ({ ...handler, matches: 0 }));
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    const route = routes.find((candidate) => candidate.method === call.method
      && (typeof candidate.path === "string" ? candidate.path === path : path.search(candidate.path) !== -1));
    if (!route) throw new Error(`unmatched request: ${call.method} ${path}`);
    const n = route.matches++;
    const reply = typeof route.reply === "function" ? await route.reply(call, n) : route.reply;
    if (reply === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }));
  return { calls };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export const seriesA: SeriesRow = {
  id: "ser_00000000000a", owner_id: "usr_alice", title: "Ashfall", genre_rubric_id: null, foundation: {},
};
export const seriesB: SeriesRow = { ...seriesA, id: "ser_00000000000b", title: "The Third Bell" };
export const bookA: BookRow = {
  id: "bk_00000000000a", series_id: seriesA.id, title: "Ashfall", ordinal: 1,
  label: null, status: "drafting", author_id: "usr_alice", language: "English",
};
export const bookC: BookRow = { ...bookA, id: "bk_00000000000c", title: "Ashfall Two", ordinal: 2 };
export const treeA: SeriesTree = { series: seriesA, books: [bookA] };
export const createdChapter: ChapterCreated = {
  chapter: { id: "ch_00000000000a", book_id: bookA.id, order_key: "0000001000" },
  version: {
    id: "ver_00000000000a", chapter_id: "ch_00000000000a", version_no: 1, source: "draft_edit",
    text_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    hints_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    parent_version: null, l_seq: 1,
  },
};
export const chapterA: ChapterListItem = {
  ...createdChapter.chapter, title: null, word_count: 0,
  version_id: createdChapter.version.id, active_version_id: null,
};

export const seriesPath = "/api/series";
export const chaptersPath = `/api/books/${bookA.id}/chapters`;
export const internalError = {
  status: 500, body: { error: { code: "internal", message: "Internal error", details: null } },
};
