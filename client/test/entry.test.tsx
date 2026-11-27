import { act, screen } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { mockApi } from "./helpers";

const { app, roots } = vi.hoisted(() => ({ app: vi.fn(() => null), roots: [] as Root[] }));

// The startup check isolates the App entry point, which becomes the shell in AXB-0033.
vi.mock("../src/App", () => ({ App: app }));
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot(element: HTMLElement) {
      const root = actual.createRoot(element);
      roots.push(root);
      return root;
    },
  };
});

test("AXB-0030 AC3 rejects invalid startup identity and mounts App for a valid identity", async () => {
  const { calls } = mockApi([]);
  async function mount(identity: string | undefined, service?: string) {
    vi.resetModules();
    vi.stubEnv("VITE_AXIS_USER", identity);
    vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN", service);
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await act(async () => { await import("../src/main"); });
    return root;
  }

  try {
    for (const identity of [undefined, "bogus"]) {
      const root = await mount(identity, 'http://invalid.test');
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The Axis user is not configured. Set VITE_AXIS_USER to a value such as usr_alice.",
      );
      expect(app).not.toHaveBeenCalled();
      act(() => roots.pop()?.unmount());
      root.remove();
    }
    const invalid = await mount("usr_alice", "http://invalid.test");
    expect(screen.getByRole("alert").textContent).toBe("The service address is invalid.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(app).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    act(() => roots.pop()?.unmount());
    invalid.remove();
    const root = await mount("usr_alice");
    expect(app).toHaveBeenCalledTimes(1);
    expect(root).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  } finally {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    document.querySelector("#root")?.remove();
  }
});
