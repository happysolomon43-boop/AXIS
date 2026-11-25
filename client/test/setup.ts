import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

vi.stubEnv("VITE_AXIS_USER", "usr_alice");
beforeEach(() => {
  vi.stubEnv("VITE_AXIS_USER", "usr_alice");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

Range.prototype.getBoundingClientRect = function () {
  const rect: DOMRect = {
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
    toJSON: () => rect,
  };
  return rect;
};
Range.prototype.getClientRects = function () {
  return { length: 0, item: () => null, *[Symbol.iterator]() {} } as DOMRectList;
};
document.elementFromPoint = () => null;
