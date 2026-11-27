import { expect, test, vi } from "vitest";
import { readClientOrigins } from "../src/http/clientOrigins.js";
import { buildApp } from "../src/app.js";
import type { Pool } from "pg";

const pool = {} as Pool;
const allowed = ["https://writer.example.test", "https://axis.example.test:8443",
  "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173",
  "http://writer.dev.localhost:5173", "capacitor://localhost", "tauri://localhost"];

test("AXB-0121 AC1 defaults, exact membership and deduplication", async () => {
  expect(readClientOrigins(undefined).size).toBe(0);
  expect(readClientOrigins("[]").size).toBe(0);
  const set = readClientOrigins(JSON.stringify([allowed[0], allowed[0], "tauri://localhost"]));
  expect([...set]).toEqual([allowed[0], "tauri://localhost"]);
  expect(set.has("https://other.example.test")).toBe(false);
  expect(set.has("https://writer.example.test/")).toBe(false);
  expect([...readClientOrigins(JSON.stringify(allowed))]).toEqual(allowed);
  try {
    vi.stubEnv("AXIS_ALLOWED_CLIENT_ORIGINS", JSON.stringify(allowed));
    const app = buildApp({ pool });
    try {
      vi.stubEnv("AXIS_ALLOWED_CLIENT_ORIGINS", "[]");
      expect((await app.inject({ method: "GET", url: "/health", headers: { origin: allowed[0]! } })).headers["access-control-allow-origin"]).toBe(allowed[0]);
    } finally { await app.close(); }
  } finally { vi.unstubAllEnvs(); }
});

test("AXB-0121 AC2 rejects the entire invalid configuration at app construction", () => {
  const invalid = ["", "{", "null", "{}", '"https://writer.example.test"', "[null]",
    ...["*", "null", "file://localhost", "https://writer.example.test/", "https://writer.example.test/a",
      "https://writer.example.test:443", "https://WRITER.example.test", " https://writer.example.test",
      "https://u@writer.example.test", "https://writer.example.test?x", "https://writer.example.test#x",
      "http://other.example.test", "http://notlocalhost", "http://.localhost", "capacitor://localhost/",
      "tauri://other"].map(value => JSON.stringify([value])),
    JSON.stringify([allowed[0], "null"])];
  try {
    for (const raw of invalid) {
      vi.stubEnv("AXIS_ALLOWED_CLIENT_ORIGINS", raw);
      expect(() => buildApp({ pool }), raw).toThrowError(/^Invalid AXIS_ALLOWED_CLIENT_ORIGINS$/);
    }
  } finally { vi.unstubAllEnvs(); }
});
