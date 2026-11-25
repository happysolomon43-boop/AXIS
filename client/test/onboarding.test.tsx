import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Onboarding } from "../src/onboarding/Onboarding";
import { deferred, internalError, mockApi, seriesA, seriesPath, treeA } from "./helpers";

function mountOnboarding() {
  const onStarted = vi.fn();
  const onExisting = vi.fn();
  const view = render(<Onboarding onStarted={onStarted} onExisting={onExisting} />);
  const form = screen.getByRole("form");
  const input = screen.getByRole("textbox");
  const start = screen.getByRole("button", { name: "Start a new Book" });
  return { ...view, onStarted, onExisting, form, input, start };
}

test("AXB-0031 AC1 validates exact title boundaries and submits once", async () => {
  const pending = deferred<{ status: number; body: typeof treeA }>();
  const { calls } = mockApi([{ method: "POST", path: seriesPath, reply: () => pending.promise }]);
  const user = userEvent.setup();
  const { form, input, start, onStarted, onExisting } = mountOnboarding();

  expect(input).toHaveFocus();
  expect(start).toHaveAttribute("aria-disabled", "true");
  expect(start).not.toBeDisabled();
  for (const value of ["   ", "\u3000", "\u0085", "A\u0000B"]) {
    fireEvent.change(input, { target: { value } });
    await user.click(start);
    expect(start).toHaveFocus();
    expect(start).toHaveAttribute("aria-disabled", "true");
  }
  expect(calls).toEqual([]);

  fireEvent.change(input, { target: { value: "😀".repeat(200) } });
  expect(start).not.toHaveAttribute("aria-disabled", "true");
  fireEvent.change(input, { target: { value: "😀".repeat(201) } });
  const message = screen.getByText("Use 200 characters or fewer.");
  expect(message).toHaveAttribute("data-part", "title-message");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription(message.textContent);
  expect(start).toHaveAttribute("aria-disabled", "true");

  fireEvent.change(input, { target: { value: " \u0085 Ashfall \u3000 " } });
  await user.click(input);
  await user.keyboard("{Enter}");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "POST", path: seriesPath, body: { title: "Ashfall" } });
  expect(calls[0].headers.get("X-Axis-User")).toBe("usr_alice");
  expect(form).toHaveAttribute("data-state", "creating");
  expect(input).toHaveAttribute("readonly");
  expect(start).toHaveAttribute("aria-disabled", "true");
  expect(start).toBe(screen.getByRole("button"));
  await user.click(start);
  expect(calls).toHaveLength(1);

  await act(async () => pending.resolve({ status: 201, body: treeA }));
  expect(onStarted).toHaveBeenCalledTimes(1);
  expect(onStarted).toHaveBeenCalledWith(treeA);
  expect(onExisting).not.toHaveBeenCalled();
  expect(calls.map(({ method }) => method)).toEqual(["POST"]);
});

test("AXB-0031 AC2 checks for an existing Series before offering another write", async () => {
  const observed = deferred<{ status: number; body: { series: typeof seriesA[] } }>();
  const persisted: typeof seriesA[] = [];
  let api = mockApi([
    { method: "POST", path: seriesPath, reply: () => { persisted.push(seriesA); return "network"; } },
    { method: "GET", path: seriesPath, reply: () => observed.promise },
  ]);
  let view = mountOnboarding();
  fireEvent.change(view.input, { target: { value: "Ashfall" } });
  fireEvent.submit(view.form);
  expect(await screen.findByRole("status")).toHaveAttribute("data-part", "checking");
  expect(view.form).toHaveAttribute("data-state", "checking");
  expect(view.input).toHaveAttribute("readonly");
  fireEvent.submit(view.form);
  await act(async () => observed.resolve({ status: 200, body: { series: persisted } }));
  expect(api.calls.map(({ method }) => method)).toEqual(["POST", "GET"]);
  expect(view.onExisting).toHaveBeenCalledTimes(1);
  expect(view.onExisting).toHaveBeenCalledWith([seriesA]);
  expect(view.onStarted).not.toHaveBeenCalled();
  cleanup();

  const empty = { status: 200, body: { series: [] } };
  const created = { status: 201, body: treeA };
  api = mockApi([
    { method: "POST", path: seriesPath, reply: (_, n) => n === 0 ? internalError : created },
    { method: "GET", path: seriesPath, reply: empty },
  ]);
  view = mountOnboarding();
  fireEvent.change(view.input, { target: { value: "Ashfall" } });
  fireEvent.submit(view.form);
  expect(await screen.findByRole("alert")).toHaveAttribute("data-part", "failure");
  expect(view.form).toHaveAttribute("data-state", "idle");
  expect(view.input).toHaveValue("Ashfall");
  expect(view.start).not.toHaveAttribute("aria-disabled", "true");
  fireEvent.submit(view.form);
  await waitFor(() => expect(view.onStarted).toHaveBeenCalledTimes(1));
  expect(view.onStarted).toHaveBeenCalledWith(treeA);
  expect(api.calls.map(({ method }) => method)).toEqual(["POST", "GET", "POST"]);
  cleanup();

  api = mockApi([
    { method: "POST", path: seriesPath, reply: internalError },
    { method: "GET", path: seriesPath, reply: (_, n) => n === 0 ? internalError : empty },
  ]);
  view = mountOnboarding();
  fireEvent.change(view.input, { target: { value: "Ashfall" } });
  fireEvent.submit(view.form);
  expect(await screen.findByRole("alert")).toHaveAttribute("data-part", "failure");
  expect(view.form).toHaveAttribute("data-state", "check-failed");
  expect(view.start).toHaveAttribute("aria-disabled", "true");
  fireEvent.submit(view.form);
  fireEvent.click(view.container.querySelector('[data-part="check-again"]')!);
  await waitFor(() => expect(view.form).toHaveAttribute("data-state", "idle"));
  expect(api.calls.map(({ method }) => method)).toEqual(["POST", "GET", "GET"]);
  cleanup();

  const pending = deferred<typeof created>();
  api = mockApi([{ method: "POST", path: seriesPath, reply: () => pending.promise }]);
  view = mountOnboarding();
  fireEvent.change(view.input, { target: { value: "Ashfall" } });
  fireEvent.submit(view.form);
  view.unmount();
  await act(async () => pending.resolve(created));
  expect(view.onStarted).not.toHaveBeenCalled();
  expect(view.onExisting).not.toHaveBeenCalled();
  expect(api.calls.map(({ method }) => method)).toEqual(["POST"]);
});
