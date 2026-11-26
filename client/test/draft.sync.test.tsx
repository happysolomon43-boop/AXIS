import { act, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChapterSync } from "../src/api/types";
import { versionChip } from "../src/binder/format";
import { c, chapterPath, detailText, reply, writtenC } from "./d06.fixtures";
import { advance, conflictEnvelope, draftNone, draftPath, edit, fakeClock, mountDraft, putOk } from "./draftFixtures";
import { deferred, type Call } from "./helpers";
import { syncDraftOnly, syncEdited, syncInBook, syncRevised, syncRevisedSame, withSync } from "./syncDraftFixtures";

const readHead = (sync: ChapterSync) => withSync({ status: 200, body: draftNone }, sync);
const put = (revision: number, sync: ChapterSync) => withSync({ status: 200, body: putOk(revision) }, sync);
const chip = (ui: ReturnType<typeof mountDraft>) => ui.part("version-chip")?.textContent ?? null;
const requests = (calls: Call[]) => calls.map(({ method, path }) => method + " " + path);
const openReads = ["GET " + chapterPath, "GET " + draftPath];

afterEach(() => vi.useRealTimers());

test("AXB-0078 AC1 draws the served state on the two existing open reads", async () => {
  const unknown = { state: "unknown", same: false } as unknown as ChapterSync;
  for (const [sync, text] of [
    [syncDraftOnly, "Draft only"], [syncInBook, null], [syncEdited, "In Book, edited since upload"],
    [syncRevisedSame, "Being revised, no changes yet"], [syncRevised, "Being revised"], [unknown, null],
  ] as const) {
    const ui = mountDraft({ draft: readHead(sync) });
    await ui.loaded();
    expect(chip(ui)).toBe(text);
    expect(requests(ui.calls)).toEqual(openReads);
    ui.unmount();
  }
});

test("AXB-0078 AC2 changes the chip only when an autosave or conflict re-read supplies sync", async () => {
  const first = deferred<ReturnType<typeof put>>();
  const conflictRead = deferred<ReturnType<typeof readHead>>();
  const ui = mountDraft({
    draft: (_, n) => n === 0 ? readHead(syncInBook) : conflictRead.promise,
    put: (_, n) => [first.promise, put(2, syncInBook), conflictEnvelope][n],
  });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  await advance(1000);
  edit(ui.view());
  await advance(1999);
  expect(ui.puts()).toHaveLength(0);
  expect(chip(ui)).toBeNull();
  await advance(1);
  expect(ui.puts()).toHaveLength(1);
  expect(chip(ui)).toBeNull();
  await act(async () => { first.resolve(put(1, syncEdited)); });
  expect(chip(ui)).toBe("In Book, edited since upload");

  edit(ui.view());
  expect(chip(ui)).toBe("In Book, edited since upload");
  await advance(5000);
  expect(ui.puts()).toHaveLength(2);
  expect(chip(ui)).toBeNull();

  edit(ui.view());
  await advance(5000);
  expect(ui.puts()).toHaveLength(3);
  expect(requests(ui.calls)).toEqual([...openReads, ...Array(3).fill("PUT " + draftPath), "GET " + draftPath]);
  expect(chip(ui)).toBeNull();
  await act(async () => { conflictRead.resolve(readHead(syncRevised)); });
  expect(ui.root).toHaveAttribute("data-state", "conflict");
  expect(chip(ui)).toBe("Being revised");
  ui.unmount();
});

test("AXB-0078 AC3 applies Save sync and clears it on Send", async () => {
  for (const [kind, version, text] of [
    ["versions", withSync({ status: 201, body: writtenC(c) }, syncRevised), "Being revised"],
    ["versions", withSync({ status: 201, body: writtenC(c) }, syncInBook), null],
    ["send", reply(writtenC(c), 201), null],
  ] as const) {
    const path = chapterPath + "/" + kind;
    const ui = mountDraft({
      draft: readHead(syncRevisedSame),
      writes: [{ method: "POST", path, reply: version }],
    });
    await ui.loaded();
    fakeClock();
    edit(ui.view());
    await act(async () => { fireEvent.click(ui.part(kind === "send" ? "send" : "save")); });
    expect(ui.root).toHaveAttribute("data-state", "clean");
    expect(chip(ui)).toBe(text);
    expect(requests(ui.calls)).toEqual([...openReads, "POST " + path]);
    ui.unmount();
    vi.useRealTimers();
  }
});

test("AXB-0078 AC4 falls back to the id rule for old replies and a landed-by-settle Save", async () => {
  const expected = versionChip({ version_id: detailText.version!.id, active_version_id: detailText.active_version_id });
  const old = mountDraft({ put: reply(putOk(1)) });
  await old.loaded();
  expect(chip(old)).toBe(expected);
  fakeClock();
  edit(old.view());
  await advance(2000);
  expect(chip(old)).toBe(expected);
  expect(requests(old.calls)).toEqual([...openReads, "PUT " + draftPath]);
  old.unmount();
  vi.useRealTimers();

  const written = writtenC(c);
  const ui = mountDraft({
    chapter: (_, n) => reply(n === 0 ? detailText : {
      ...detailText, version: { ...written.version, content: detailText.version!.content + "!" }, active_version_id: c,
    }),
    draft: readHead(syncRevisedSame),
    writes: [{ method: "POST", path: chapterPath + "/versions", reply: "network" }],
  });
  await ui.loaded();
  fakeClock();
  edit(ui.view());
  await act(async () => { fireEvent.click(ui.part("save")); });
  expect(ui.root).toHaveAttribute("data-state", "clean");
  expect(chip(ui)).toBeNull();
  expect(requests(ui.calls)).toEqual([...openReads, "POST " + chapterPath + "/versions", "GET " + chapterPath]);
  ui.unmount();
});
