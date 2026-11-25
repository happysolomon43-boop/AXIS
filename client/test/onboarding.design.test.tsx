import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Onboarding } from "../src/onboarding/Onboarding";
import baseCss from "../src/styles/base.css?raw";
import onboardingCss from "../src/onboarding/onboarding.css?raw";
import { internalError, mockApi, seriesPath } from "./helpers";

test("AXB-0031 AC3 draws the Onboarding parts and exact design rules", async () => {
  mockApi([
    { method: "POST", path: seriesPath, reply: internalError },
    { method: "GET", path: seriesPath, reply: internalError },
  ]);
  render(<Onboarding onStarted={vi.fn()} onExisting={vi.fn()} />);
  const form = screen.getByRole("form");
  const headline = screen.getByRole("heading", { name: "Bring me what you have." });
  const input = screen.getByLabelText("Title");
  const start = screen.getByRole("button", { name: "Start a new Book" });
  const [motif, heading, field, actions, privacy] = [...form.children];
  expect(form).toHaveClass("ax-onboarding");
  expect(form).toHaveAttribute("aria-labelledby", headline.id);
  expect(motif.tagName.toLowerCase()).toBe("svg");
  expect(motif).toHaveAttribute("data-part", "axis");
  expect(motif).toHaveAttribute("aria-hidden", "true");
  expect(heading).toBe(headline);
  expect(headline.tagName).toBe("H1");
  expect(headline).toHaveAttribute("data-part", "headline");
  expect(field).toHaveClass("ax-field");
  expect(field.querySelector("label")).toHaveClass("ax-field-label");
  expect(field.querySelector("input")).toBe(input);
  expect(input).toHaveClass("ax-input");
  expect(actions).toHaveAttribute("data-part", "actions");
  expect(actions).toHaveClass("ax-onboarding-actions");
  expect(actions).toContainElement(start);
  expect(start).toHaveClass("ax-button", "ax-button--primary", "ax-button--wide");
  expect(privacy).toHaveAttribute("data-part", "privacy");
  expect(privacy).toHaveTextContent("Your drafts stay in your account. Nothing is read until you send a chapter.");

  fireEvent.change(input, { target: { value: "a".repeat(201) } });
  const message = screen.getByText("Use 200 characters or fewer.");
  expect(message).toHaveClass("ax-field-message");
  expect(message.previousElementSibling).toBe(field);
  expect(message.nextElementSibling).toBe(actions);
  expect(message.firstElementChild).toHaveClass("ax-glyph-square");
  expect(message.firstElementChild).toHaveAttribute("data-part", "message-glyph");
  expect(message.firstElementChild).toHaveAttribute("aria-hidden", "true");

  fireEvent.change(input, { target: { value: "Ashfall" } });
  fireEvent.submit(form);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveClass("ax-status", "ax-onboarding-status");
  expect(alert.previousElementSibling).toBe(actions);
  expect(alert.nextElementSibling).toBe(privacy);
  expect(actions.querySelector('[data-part="check-again"]')).toHaveClass("ax-button", "ax-button--secondary");

  expect((baseCss + onboardingCss).includes("severity-break")).toBe(false);
  expect(baseCss + onboardingCss).not.toMatch(/#[\da-f]{3,8}\b/i);
  expect(onboardingCss.replace(/\s+/g, "")).toBe(expectedCss.replace(/\s+/g, ""));
});

const expectedCss = `
.ax-onboarding {
  max-inline-size: var(--ax-size-onboarding);
  margin-inline: auto;
  padding: var(--ax-space-9) var(--ax-space-6) var(--ax-space-8);
}
.ax-onboarding .ax-axis-motif { margin-inline: auto; }
.ax-onboarding [data-part="headline"] {
  margin: var(--ax-space-6) 0 var(--ax-space-7);
  font-size: var(--ax-type-title-l-size);
  line-height: var(--ax-type-title-l-lh);
  font-weight: var(--ax-type-title-l-weight);
  letter-spacing: var(--ax-type-title-l-tracking);
  text-align: center;
  color: var(--ax-color-text-primary);
}
.ax-onboarding-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--ax-space-3);
  margin-block-start: var(--ax-space-6);
}
.ax-onboarding-status { margin-block-start: var(--ax-space-5); text-align: center; }
.ax-onboarding-privacy {
  max-inline-size: 44ch;
  margin: var(--ax-space-5) auto 0;
  text-align: center;
  font-size: var(--ax-type-small-size);
  line-height: var(--ax-type-small-lh);
  color: var(--ax-color-text-tertiary);
}
`;
