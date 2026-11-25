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
