import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, test } from "vitest";
import { ComparePage } from "../src/history/ComparePage";
import pageSource from "../src/history/ComparePage.tsx?raw";
import { chapter, choices, ok, rawV1, rawV2, text, textPath, v1, v2, v3 } from "./d20Fixtures";
import { deferred, mockApi } from "./helpers";

const labelA = "v1 · Saved · 16 Nov 2026 09:00";
const labelB = "v3 · Restored · 16 Nov 2026 11:00";
const label2 = "v2 · Sent · 16 Nov 2026 10:00";
const source = (side: string) => screen.getByRole("region", { name: `Text ${side}` }).firstElementChild!;
const heading = () => screen.getByRole("heading", { name: "Compare versions" });
const textA = () => screen.getByRole("region", { name: "Text A" });
const textB = () => screen.getByRole("region", { name: "Text B" });
const button = (name: string) => screen.getByRole("button", { name });

function mount(singleton = false) {
  const versions = singleton ? choices.filter(row => row.id === v1) : choices;
  return render(<StrictMode><ComparePage chapterId={chapter.id} versions={versions} a={v1}
    b={singleton ? null : v3} timeZone="UTC" /></StrictMode>);
}
function sources() {
  return [
    { method: "GET", path: textPath(v1), reply: ok(text(v1)) },
    { method: "GET", path: textPath(v2), reply: ok(text(v2)) },
    { method: "GET", path: textPath(v3), reply: ok(text(v3)) },
  ];
}

test("AC1 labels the singleton without a control or source request", async () => {
  const api = mockApi([]);
  mount(true);
  expect(screen.getByText("One version so far")).toBeVisible();
  expect(screen.getByRole("group", { name: "Side A" })).toHaveTextContent(labelA);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Swap" })).toBeNull();
  await act(async () => {});
  expect(api.calls).toEqual([]);
});

test("AC2 exposes exact text and the empty description only when both sides settle", async () => {
  const a = deferred<ReturnType<typeof ok>>();
  const b = deferred<ReturnType<typeof ok>>();
  const api = mockApi([
    { method: "GET", path: textPath(v1), reply: () => a.promise },
    { method: "GET", path: textPath(v3), reply: () => b.promise },
  ]);
  mount();
  expect(screen.getByRole("status")).toHaveTextContent("Diffing at ledger 43");
  expect(screen.queryAllByRole("region")).toHaveLength(0);
  await act(async () => a.resolve(ok(text(v1))));
  expect(screen.queryAllByRole("region")).toHaveLength(0);
  await act(async () => b.resolve(ok(text(v3))));
  expect(source("A").textContent).toBe(rawV1);
  expect(source("B").textContent).toBe("");
  expect(textB()).toHaveAccessibleDescription("Empty version");
  expect(api.calls.map(call => call.path)).toEqual([textPath(v1), textPath(v3)]);
});

test("AC3 swaps admitted bodies without I/O and changes either side while retaining the opposite side", async () => {
  const api = mockApi(sources());
  mount();
  await screen.findByRole("region", { name: "Text A" });
  const swap = button("Swap");
  swap.focus();
  fireEvent.click(swap);
  expect(swap).toHaveFocus();
  expect(source("A").textContent).toBe("");
  expect(source("B").textContent).toBe(rawV1);
  expect(api.calls).toHaveLength(2);

  const a = screen.getByRole("combobox", { name: "Version A" });
  const b = screen.getByRole("combobox", { name: "Version B" });
  expect(within(a).queryByRole("option", { name: labelA })).toBeNull();
  expect(within(b).queryByRole("option", { name: labelB })).toBeNull();
  fireEvent.change(a, { target: { value: v3 } });
  expect(api.calls).toHaveLength(2);
  a.focus();
  fireEvent.change(a, { target: { value: v2 } });
  expect(screen.queryAllByRole("region")).toHaveLength(0);
  await screen.findByRole("region", { name: "Text A" });
  expect(a).toHaveFocus();
  expect(source("A").textContent).toBe(rawV2);
  expect(source("B").textContent).toBe(rawV1);
  expect(screen.getByRole("group", { name: "Side A" })).toHaveTextContent(label2);
  expect(within(b).queryByRole("option", { name: label2 })).toBeNull();
  expect(api.calls.map(call => call.path)).toEqual([textPath(v1), textPath(v3), textPath(v2), textPath(v1)]);
});

test.each([[401, "auth_required"], [404, "not_found"], [500, "internal"], [0, "network"],
  [200, "unreadable"], [503, "busy"]] as const)(
  "AC4 %i %s fails atomically and retries the same IDs", async (status, code) => {
    const held = deferred<ReturnType<typeof ok>>();
    const retry = deferred<ReturnType<typeof ok>>();
    const api = mockApi([
      { method: "GET", path: textPath(v1), reply: (_, n) => n ? retry.promise : status === 0 ? "network"
        : { status, body: { error: { code, message: "Private server detail", details: null } } } },
      { method: "GET", path: textPath(v3), reply: (_, n) => n ? ok(text(v3)) : held.promise },
    ]);
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("These versions could not be opened.");
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => held.resolve(ok(text(v3))));
    expect(screen.getAllByRole("alert")).toEqual([alert]);
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    button("Try again").focus();
    fireEvent.click(button("Try again"));
    expect(heading()).toHaveFocus();
    await waitFor(() => expect(api.calls.map(call => call.path)).toEqual([
      textPath(v1), textPath(v3), textPath(v1), textPath(v3),
    ]));
    await act(async () => retry.resolve(ok(text(v1))));
    expect(textA().textContent).toBe(rawV1);
    expect(heading()).toHaveFocus();
  },
);

test("AC5 binds each state to its exact markup, child order, focus targets and literal text nodes", async () => {
  const old = deferred<ReturnType<typeof ok>>();
  const sample = "<b> Raw & unchanged </b>\r\n";
  mockApi([
    { method: "GET", path: textPath(v1), reply: (_, n) => n ? ok(text(v1, sample)) : old.promise },
    { method: "GET", path: textPath(v3), reply: (_, n) => ok(text(v3, n > 1 ? "  " : "")) },
  ]);
  const singleton = mount(true);
  function check(state: string, last: string) {
    const element = document.querySelector("[data-surface=compare]")!;
    expect(element.tagName).toBe("SECTION");
    expect(element).toHaveClass("ax-compare");
    expect(element).toHaveAttribute("data-state", state);
    const column = element.firstElementChild!;
    expect(column).toHaveClass("ax-compare__column");
    expect(column.firstElementChild).toBe(heading());
    expect(heading().tagName).toBe("H2");
    expect(heading()).toHaveAttribute("tabindex", "-1");
    expect(heading()).toHaveAttribute("data-part", "heading");
    expect(heading()).toHaveClass("ax-compare__heading");
    expect(column.lastElementChild).toHaveClass(last);
    expect(element.querySelector("[style], [role=progressbar], [autofocus]")).toBeNull();
    return element;
  }
  const one = check("one", "ax-compare__one");
  expect(one.querySelector("p[data-part=one-version]")).toHaveTextContent("One version so far");
  expect(one.querySelector("[data-part=controls], [data-part=panels], .ax-reading-rule")).toBeNull();
  singleton.unmount();

  mount();
  const loading = check("loading", "ax-compare__reading");
  expect(loading.querySelector("p[data-part=status] + div.ax-reading-rule")).toHaveAttribute("aria-hidden", "true");
  expect(loading.querySelector("[data-part=panels], [data-part=version-chip], [data-part=text]")).toBeNull();
  const controls = loading.querySelector("div[data-part=controls]")!;
  expect(controls).toHaveClass("ax-compare__controls");
  expect(controls.children).toHaveLength(3);
  for (const [index, side] of ["A", "B"].entries()) {
    const field = controls.children[index];
    expect(field).toHaveClass("ax-compare__field");
    expect(field.firstElementChild).toHaveClass("ax-compare__label");
    const input = screen.getByLabelText(`Version ${side}`);
    expect(field.lastElementChild).toBe(input);
    expect(input).toHaveClass("ax-compare__select");
    expect(input).toHaveAttribute("data-part", `select-${side.toLowerCase()}`);
    expect(input).toBeEnabled();
    expect(input).not.toHaveAttribute("aria-disabled");
  }
  expect(controls.lastElementChild).toBe(button("Swap"));
  expect(button("Swap")).toHaveClass("ax-button", "ax-button--secondary", "ax-compare__swap");
  await act(async () => old.resolve({ status: 404, body: null }));
  const failed = check("failed", "ax-compare__failure");
  expect(failed.querySelector("p[data-part=failure] + button[data-part=try-again]")).toBe(button("Try again"));
  expect(button("Try again")).toHaveClass("ax-button", "ax-button--secondary", "ax-compare__retry");
  expect(failed.querySelector("[data-part=text], .ax-reading-rule")).toBeNull();

  fireEvent.click(button("Try again"));
  await screen.findByRole("region", { name: "Text B" });
  const ready = check("ready", "ax-compare__controls");
  const panels = ready.lastElementChild!;
  expect(panels).toHaveClass("ax-compare__panels");
  expect(panels).toHaveAttribute("data-part", "panels");
  expect(ready.querySelector("[role=status], [role=alert], .ax-reading-rule")).toBeNull();
  for (const [index, [side, id, region]] of [["A", v1, textA()], ["B", v3, textB()]].entries()) {
    const panel = panels.children[index];
    expect(panel).toHaveClass("ax-compare__panel");
    const chip = screen.getByRole("group", { name: `Side ${side}` });
    expect(panel.firstElementChild).toBe(chip);
    expect(chip).toHaveClass("ax-compare__chip");
    expect(chip).toHaveAttribute("data-part", "version-chip");
    expect(chip).toHaveAttribute("data-version-id", id as string);
    expect(chip.firstElementChild).toHaveClass("ax-compare__key");
    expect(chip.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(chip.lastElementChild).toHaveClass("ax-compare__chip-label");
    expect(panel.children[1]).toBe(region);
    expect(region).toHaveClass("ax-compare__text", "ax-page");
    expect(region).toHaveAttribute("tabindex", "0");
    expect((region as HTMLElement).children).toHaveLength(1);
    expect(source(side as string)).toHaveClass("ax-compare__source");
  }
  expect(source("A").childNodes).toHaveLength(1);
  expect(source("A").firstChild?.nodeType).toBe(Node.TEXT_NODE);
  expect(source("A").textContent).toBe(sample);
  expect(source("B").childNodes).toHaveLength(0);
  expect(textB().nextElementSibling).toHaveClass("ax-compare__empty");
  expect(textB()).toHaveAccessibleDescription("Empty version");
  expect(pageSource).toContain('import "../styles/compare.css"');
});
