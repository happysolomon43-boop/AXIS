import { writeResponse } from "./writeFixtures";
import { useState } from "react";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { HistoryItem } from "../src/api/types";
import { History } from "../src/history/History";
import { reply } from "./d06.fixtures";
import { contrast } from "./draftFixtures";
import { deferred, mockApi, seriesA } from "./helpers";
import { chapterA, historyColors, historyPath, versionTextB } from "./historyFixtures";
import {
  checkpointRow, historyAfterCheckpoint, historyAfterCheckpointNamed, historyAfterRestore,
  historyH3, internalEnvelope, restorePath, restoreReply, restoreReplyCp, rowB,
} from "./restoreFixtures";

const restored = "Restored into your draft. The Book is unchanged until you send.";
const note = "Your unsaved text was kept as the snapshot “Before restore”.";
type Handler = Parameters<typeof mockApi>[0][number];

function mount(history: Handler["reply"], post: Handler["reply"] = restoreReplyCp) {
  const { calls } = mockApi([
    { method: "GET", path: historyPath, reply: history },
    { method: "GET", path: /\/versions\/ver_[0-9a-f]+$/, reply: (call) => reply({ ...versionTextB, version: { ...versionTextB.version, id: call.path.split("/").at(-1) } }) },
    { method: "POST", path: restorePath, reply: async (call, n) => writeResponse(call, typeof post === "function" ? await post(call, n) : post) },
  ]);
  function Surface() {
    const [token, setToken] = useState(0);
    return <History chapterId={chapterA.id} seriesId={seriesA.id} timeZone="UTC" refreshToken={token}
      onRestored={() => {
        setToken((current) => current + 1);
        return "applied";
      }} />;
  }
  const ui = render(<Surface />);
  const part = (name: string, scope: ParentNode = ui.container) =>
    scope.querySelector<HTMLElement>(`[data-part="${name}"]`);
  const row = (id: string) => ui.container.querySelector<HTMLElement>(`[data-version-id="${id}"]`);
  const rows = () => [...ui.container.querySelectorAll<HTMLElement>("[data-version-id]")];
  async function ready() {
    await waitFor(() => expect(part("snapshot-filter")).toBeInTheDocument());
  }
  async function open(id: string) {
    await ready();
    const entry = row(id)!;
    fireEvent.click(part("version-open", entry)!);
    await waitFor(() => expect(part("version-detail", entry)).toHaveAttribute("data-state", "ready"));
    return entry;
  }
  async function restoreOlder() {
    const entry = await open(rowB.id);
    await act(async () => { fireEvent.click(part("version-restore", entry)!); });
  }
  return { ...ui, part, row, rows, ready, open, restoreOlder, calls };
}

test("AXB-0117 AC1: refresh supplies the automatic snapshot and it can be restored from Named", async () => {
  const refresh = deferred<ReturnType<typeof reply>>();
  const nextRestore = deferred<typeof restoreReply>();
  const ui = mount((_, n) => n === 0 ? reply(historyH3) : refresh.promise,
    (_, n) => n === 0 ? restoreReplyCp : nextRestore.promise);
  await ui.restoreOlder();
  expect(ui.part("restore-status")?.textContent).toBe(`${restored} ${note}`);
  fireEvent.click(ui.part("snapshot-named")!);
  expect(ui.rows()).toHaveLength(0);
  expect(ui.calls.filter(({ path }) => path === historyPath)).toHaveLength(2);

  await act(async () => { refresh.resolve(reply(historyAfterCheckpointNamed)); });
  const checkpoint = ui.row(checkpointRow.id)!;
  expect(ui.rows()).toEqual([checkpoint]);
  expect(ui.part("version-source", checkpoint)).toHaveTextContent(/^Checkpoint$/);
  expect(within(checkpoint).getByText("Before restore")).toBeInTheDocument();
  expect(within(checkpoint).getByText("automatic", { exact: true })).toBeInTheDocument();
  expect(checkpoint.querySelector(".ax-history__snapshot-key")).toHaveTextContent(/^A$/);

  fireEvent.click(ui.part("snapshot-all")!);
  expect(ui.rows()).toHaveLength(historyAfterCheckpointNamed.versions.length);
  const allCheckpoint = ui.row(checkpointRow.id)!;
  expect(within(allCheckpoint).getByText("automatic", { exact: true })).toBeInTheDocument();
  expect(allCheckpoint.querySelector(".ax-history__snapshot-key")).toHaveTextContent(/^A$/);
  fireEvent.click(ui.part("snapshot-named")!);
  const expanded = await ui.open(checkpointRow.id);
  expect(ui.part("version-restore", expanded)).toHaveTextContent(/^Restore this version$/);
  expect(ui.part("snapshot-remove", expanded)).toHaveTextContent(/^Remove snapshot name$/);
  expect(ui.part("snapshot-name-action", expanded)).toBeNull();
  expect(ui.part("snapshot-name-form")).toBeNull();
  fireEvent.click(ui.part("version-restore", expanded)!);
  fireEvent.click(ui.part("version-restore", expanded)!);
  expect(ui.calls.filter(({ method }) => method === "POST")).toMatchObject([
    { path: restorePath, body: { version_id: rowB.id } },
    { path: restorePath, body: { version_id: checkpointRow.id } },
  ]);
});

test("AXB-0117 AC2: the note is conditional on the Restore reply", async () => {
  const ui = mount((_, n) => reply(n === 0 ? historyH3 : historyAfterRestore), restoreReply);
  await ui.restoreOlder();
  expect(ui.part("restore-status")?.textContent).toBe(restored);
});

test("AXB-0117 AC2: a failed refresh preserves the status without inventing a snapshot", async () => {
  const ui = mount((_, n) => n === 0 ? reply(historyH3) : internalEnvelope);
  await ui.restoreOlder();
  expect(ui.part("restore-status")?.textContent).toBe(`${restored} ${note}`);
  expect(ui.part("refresh-failure")).toHaveTextContent("The history could not be refreshed.");
  expect(ui.part("refresh-again")).toBeInTheDocument();
  fireEvent.click(ui.part("snapshot-named")!);
  expect(ui.rows()).toHaveLength(0);
  expect(ui.part("restore-status")?.textContent).toBe(`${restored} ${note}`);
});

test("AXB-0117 AC2: a legacy checkpoint without snapshot metadata appears only in All", async () => {
  const ui = mount(reply(historyAfterCheckpoint));
  await ui.ready();
  const checkpoint = ui.row(checkpointRow.id)!;
  expect(checkpoint).toBeInTheDocument();
  expect(ui.part("snapshot-name", checkpoint)).toBeNull();
  expect(checkpoint.querySelector(".ax-history__snapshot-key")).toBeNull();
  fireEvent.click(ui.part("snapshot-named")!);
  expect(ui.row(checkpointRow.id)).toBeNull();
});

test("AXB-0117 AC3: plain status markup, one announcement and contrast in all three themes", async () => {
  async function statusMarkup(hasCheckpoint: boolean) {
    const history = hasCheckpoint ? historyAfterCheckpointNamed : historyAfterRestore;
    const ui = mount((_, n) => reply(n === 0 ? historyH3 : history), hasCheckpoint ? restoreReplyCp : restoreReply);
    await ui.restoreOlder();
    const status = ui.part("restore-status")!;
    expect(status.textContent).toBe(hasCheckpoint ? `${restored} ${note}` : restored);
    expect(document.body.textContent?.split(note)).toHaveLength(hasCheckpoint ? 2 : 1);
    expect(status).toHaveAttribute("role", "status");
    expect(status).not.toHaveAttribute("style");
    expect(status.children).toHaveLength(0);
    expect(status.querySelector("svg, img, a, button")).toBeNull();
    if (hasCheckpoint) {
      const sentence = status.textContent!.slice(restored.length + 1);
      expect(sentence).toContain("\u201c");
      expect(sentence).toContain("\u201d");
      expect(sentence).not.toContain("\u0022");
    }
    const result = { tag: status.tagName, role: status.getAttribute("role"), classes: [...status.classList] };
    const markup = status.outerHTML;
    ui.unmount();
    return { result, markup };
  }

  const withCheckpoint = await statusMarkup(true);
  expect(withCheckpoint.result).toEqual((await statusMarkup(false)).result);
  vi.stubGlobal("matchMedia", (media: string) => ({
    media, matches: media === "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  expect((await statusMarkup(true)).markup).toBe(withCheckpoint.markup);
  for (const { theme, room, primary, secondary } of historyColors()) {
    expect(contrast(secondary, room), theme).toBeGreaterThanOrEqual(4.5);
    expect(contrast(primary, room), theme).toBeGreaterThanOrEqual(4.5);
  }
});

test("AXB-0117 AC4: each served checkpoint has a decorative A and other snapshots keep S", async () => {
  const original = historyAfterCheckpointNamed.versions.find((row) => row.id === checkpointRow.id)!;
  const snapshot = original.snapshot!;
  const manual: HistoryItem = {
    ...rowB, source: "draft_edit", can_name_snapshot: false,
    snapshot: {
      ...snapshot, chapter_id: rowB.chapter_id, version_id: rowB.id, l_seq: rowB.l_seq, name: "Before the cut",
    },
    snapshot_lifecycle: {
      snapshot_id: "33333333-3333-4333-8333-333333333333",
      state_token: "44444444-4444-4444-8444-444444444444",
      previous_token: null,
    },
  };
  const id = "ver_0000000000a1";
  const newer: HistoryItem = {
    ...checkpointRow, id, version_no: checkpointRow.version_no + 10, l_seq: checkpointRow.l_seq + 10,
    at: "2026-11-21T09:30:00.000Z", can_name_snapshot: false,
    snapshot: {
      ...snapshot, version_id: id, l_seq: checkpointRow.l_seq + 10, created_at: "2026-11-21T09:30:00.000Z",
    },
    snapshot_lifecycle: {
      snapshot_id: "55555555-5555-4555-8555-555555555555",
      state_token: "66666666-6666-4666-8666-666666666666",
      previous_token: null,
    },
  };
  const ui = mount(reply({
    ...historyAfterCheckpointNamed,
    versions: [newer, ...historyAfterCheckpointNamed.versions.map((row) => row.id === manual.id ? manual : row)],
  }));
  await ui.ready();
  fireEvent.click(ui.part("snapshot-named")!);
  const entries = ui.rows();
  expect(entries.map((row) => row.dataset.versionId)).toEqual([newer.id, original.id, manual.id]);
  const keys = entries.map((row) => row.querySelector(".ax-history__snapshot-key")!);
  expect(keys.map((key) => key.textContent)).toEqual(["A", "A", "S"]);
  for (const key of keys) {
    expect(key).toHaveAttribute("aria-hidden", "true");
    expect(key).not.toHaveAttribute("tabindex");
    expect(key.tagName).toBe(keys[0].tagName);
    expect([...key.classList]).toEqual([...keys[0].classList]);
  }
  for (const row of entries.slice(0, 2)) {
    expect(ui.part("version-source", row)).toHaveTextContent(/^Checkpoint$/);
    expect(within(row).getByText("automatic", { exact: true })).toBeInTheDocument();
    expect(within(row).queryByText("named by you", { exact: true })).toBeNull();
    expect(within(row).getByText("Before restore")).toBeInTheDocument();
  }
  expect(entries[0].textContent).not.toBe(entries[1].textContent);
  expect(within(entries[2]).getByText("Before the cut")).toBeInTheDocument();
  expect(within(entries[2]).getByText("named by you", { exact: true })).toBeInTheDocument();

  for (const row of [newer, original]) {
    const entry = await ui.open(row.id);
    expect(ui.part("snapshot-remove", entry)).toBeInTheDocument();
    expect(ui.part("snapshot-name-action", entry)).toBeNull();
    expect(ui.part("snapshot-name-form")).toBeNull();
    if (row.id === newer.id) expect(ui.part("version-restore", entry)).toBeNull();
    else expect(ui.part("version-restore", entry)).toBeInTheDocument();
  }
});
