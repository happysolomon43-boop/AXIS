import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "../src/App";
import { copy } from "../src/copy";
import css from "../src/styles/opening.css?raw";
import { deferred, internalError, mockApi } from "./helpers";
import { service } from "./connectionFixtures";
test("AXB-0127 AC1 three exact drawings, same root and retry node",async()=>{
  vi.stubEnv("VITE_AXIS_SERVICE_ORIGIN",service);
  const first=deferred<typeof internalError>(),retry=deferred<typeof internalError>();
  mockApi([{method:"GET",path:service+"/series",reply:(_,n)=>n===0?first.promise:retry.promise}]);
  const {container}=render(<App/>);
  const root=container.querySelector("section.ax-opening")!;
  function drawing(state:string,parts:string[]){
    expect(container.firstElementChild).toBe(root);
    expect(root).toHaveAttribute("data-state",state);
    expect([...root.children].map(el=>el.getAttribute("data-part"))).toEqual(parts);
    expect(root.querySelector("svg,img")).toBeNull();
  }
  drawing("opening",["status","rule"]);
  expect(screen.getByRole("status")).toHaveClass("ax-opening__status");
  expect(screen.getByRole("status").textContent).toBe(copy["opening.status"]);
  expect(root.lastElementChild).toHaveClass("ax-reading-rule","ax-opening__rule");
  expect(root.lastElementChild).toHaveAttribute("aria-hidden","true");
  await act(async()=>first.resolve(internalError));
  drawing("failed",["failure","try-again"]);
  expect(screen.getByRole("alert")).toHaveClass("ax-opening__failure");
  const button=screen.getByRole("button",{name:copy["opening.retry"]});
  expect(button).toHaveClass("ax-button","ax-button--secondary","ax-opening__retry");
  button.focus();fireEvent.click(button);
  drawing("retrying",["status","rule","try-again"]);
  expect(screen.getByRole("button",{name:copy["opening.retry"]})).toBe(button);
  expect(button).toHaveAttribute("aria-disabled","true");expect(button).toHaveFocus();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async()=>retry.resolve(internalError));
  expect(screen.getByRole("button",{name:copy["opening.retry"]})).toBe(button);
  drawing("failed",["failure","try-again"]);
});
test("AXB-0127 AC2–4 exact design declarations, inert state, responsive rules and bound copy",()=>{
  for(const value of ["background-color: var(--ax-color-surface-shell)","min-block-size: 100vh","min-block-size: 100dvh",
    "padding-block-start: calc(var(--ax-space-9) + env(safe-area-inset-top, 0px))","padding-block-end: calc(var(--ax-space-6) + env(safe-area-inset-bottom, 0px))",
    "padding-inline-start: calc(var(--ax-space-6) + env(safe-area-inset-left, 0px))","padding-inline-end: calc(var(--ax-space-6) + env(safe-area-inset-right, 0px))",
    "display: flex","flex-direction: column","align-items: center","inline-size: min(100%, 480px)","margin-block-end: var(--ax-space-3)",
    "margin-block-end: var(--ax-space-5)","font-weight: 400","text-align: center","text-wrap: balance","font-size: 0.875rem","line-height: 1.25rem",
    "font-size: 1rem","line-height: 1.5rem","color: var(--ax-color-text-primary)","min-block-size: 32px",
    ' .ax-opening__retry[aria-disabled="true"]'.trim(),'.ax-opening__retry[aria-disabled="true"]:hover','.ax-opening__retry[aria-disabled="true"]:active',
    "color-mix(in srgb, var(--ax-color-text-primary) 40%, var(--ax-color-surface-shell))",
    "color-mix(in srgb, var(--ax-color-border-control) 40%, var(--ax-color-surface-shell))",
    "background-color: transparent","transition: none","cursor: default","@media (max-width: 767px)",
    "font-size: 0.9375rem","line-height: 1.375rem","@media (pointer: coarse)","min-block-size: 44px"])expect(css).toContain(value);
  expect(css).not.toMatch(/(?:^|[;{]\s*)(?:opacity|pointer-events|outline|height|block-size|animation|transform)\s*:/m);
  expect(css).not.toMatch(/#[\da-f]{3,8}\b|\brgb\(|\bhsl\(|@keyframes/i);
  expect([...css.matchAll(/\btransition\s*:\s*([^;]+);/g)].map(m=>m[1])).toEqual(["none"]);
  const expected={"opening.serviceInvalid":"The service address is invalid.","opening.status":"Opening your workspace…",
    "opening.identity":"Your workspace identity could not be verified.","opening.notFound":"That series could not be opened.",
    "opening.failed":"Your workspace could not be opened.","opening.retry":"Try again"} as const;
  for(const key of Object.keys(expected) as (keyof typeof expected)[]){
    expect(copy[key]).toBe(expected[key]);
    expect(copy[key]).not.toMatch(/!|\[[^\]]*\]|\b(?:AXB|CON|DGAP|DCON)-\d+|\b\w+[._]\w+\b|\d+\.\d+|\s$/);
  }
});
