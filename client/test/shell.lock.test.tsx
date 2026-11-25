import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Shell } from "../src/shell/Shell";
import { chaptersPath, mockApi, treeA } from "./helpers";
import { chapterList, fourRows } from "./d06.fixtures";

vi.mock("../src/draft/Draft", () => ({ Draft: ({ onLockChange, onWritten }: { onLockChange: (locked: boolean) => void; onWritten: () => void }) => (
  <section data-surface="draft"><button onClick={() => onLockChange(true)}>Lock</button><button onClick={() => onLockChange(false)}>Unlock</button><button onClick={onWritten}>Written</button></section>
) }));

test("AXB-0041 AC4 locks navigation, refreshes Binder after a write and retains the Draft when Binder hides", async () => {
  const { calls } = mockApi([{ method: "GET", path: chaptersPath, reply: chapterList(fourRows) }]);
  const { container } = render(<Shell tree={treeA} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Chapter 1: Title" }));
  const draft = container.querySelector('[data-surface="draft"]')!; const actions = [...container.querySelectorAll('[data-part="chapter-open"], [data-part="add-chapter"]')];
  fireEvent.click(screen.getByRole("button", { name: "Lock" })); actions.forEach(button => expect(button).toHaveAttribute("aria-disabled", "true"));
  fireEvent.click(screen.getByRole("button", { name: "Unlock" })); actions.forEach(button => expect(button).toHaveAttribute("aria-disabled", "false"));
  fireEvent.click(screen.getByRole("button", { name: "Written" })); await waitFor(() => expect(calls.map(c => c.path)).toEqual([chaptersPath, chaptersPath]));
  const door = screen.getByRole("button", { name: "Binder" }); fireEvent.click(door); fireEvent.click(door);
  expect(container.querySelector('[data-surface="draft"]')).toBe(draft); expect(calls).toHaveLength(2);
});
