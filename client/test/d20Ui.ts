import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { EditorView } from "prosemirror-view";
import { v1 } from "./d20Fixtures";

const editors = new WeakMap<HTMLElement, EditorView>();
export function recordEditor(view: EditorView) { editors.set(view.dom, view); }

export function part<T extends HTMLElement = HTMLElement>(container: ParentNode, name: string) {
  return container.querySelector<T>(`[data-part="${name}"]`)!;
}

export function liveView(container: ParentNode): EditorView {
  return editors.get(part(container, "editor"))!;
}

export async function openDraft(container: ParentNode) {
  fireEvent.click(await screen.findByRole("button", { name: /Open Chapter 1/ }));
  await waitFor(() => {
    expect(container.querySelector('[data-surface="draft"]')).toHaveAttribute("data-autosave", "saved");
    expect(part(container, "editor")).toBeInTheDocument();
  });
  return liveView(container);
}

export async function compareEntry(container: ParentNode) {
  fireEvent.click(part(container, "history-door"));
  await waitFor(() => {
    const row = container.querySelector(`[data-version-id="${v1}"] [data-part=version-open]`);
    expect(row).toBeInTheDocument();
  });
  fireEvent.click(container.querySelector(`[data-version-id="${v1}"] [data-part=version-open]`)!);
  return screen.findByRole("button", { name: "Compare" });
}
