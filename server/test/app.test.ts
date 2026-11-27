import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makePool } from "./helpers.js";

const pool = makePool();
const alice = { "x-axis-user": "usr_alice" };
let app: FastifyInstance;

beforeEach(() => {
  app = buildApp({ pool });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await pool.end();
});

test("AC1 health is reachable without identity", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "ok" });

  const withQuery = await app.inject({ method: "GET", url: "/health?check=1" });
  expect(withQuery.statusCode).toBe(200);
});

test("AC2 rejects missing, duplicated, and invalid identity before body parsing", async () => {
  const variants = [
    {},
    { "x-axis-user": "bob" },
    { "x-axis-user": "usr_Alice" },
    { "x-axis-user": "usr_a" },
    { "x-axis-user": `usr_${"a".repeat(33)}` },
    { "x-axis-user": ["usr_alice", "usr_bob"] },
  ];
  const expected = {
    error: {
      code: "auth_required",
      message: "Missing or invalid X-Axis-User header",
      details: null,
    },
  };
  for (const headers of variants) {
    const response = await app.inject({ method: "GET", url: "/nope", headers });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(expected);
  }

  const response = await app.inject({
    method: "POST",
    url: "/series",
    headers: { "content-type": "application/json" },
    payload: "{bad",
  });
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual(expected);
});

test("AC3 reports unknown routes for an identified request", async () => {
  const response = await app.inject({ method: "GET", url: "/nope", headers: alice });
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({
    error: { code: "not_found", message: "Route not found", details: null },
  });

  const withBody = await app.inject({
    method: "POST",
    url: "/nope",
    headers: { ...alice, "content-type": "application/json" },
    payload: "{bad",
  });
  expect(withBody.statusCode).toBe(404);
  expect(withBody.json()).toEqual(response.json());
});

test("AC4 hides unexpected exception details", async () => {
  app.get("/__boom", async () => { throw new Error("secret detail"); });
  const response = await app.inject({ method: "GET", url: "/__boom", headers: alice });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({
    error: { code: "internal", message: "Internal error", details: null },
  });
  expect(response.body).not.toContain("secret detail");
});

test("logs allowlisted diagnostics without manuscripts, labels, request paths, headers or exception details", async () => {
  const output: string[] = [];
  const log = new Writable({
    write(chunk, _encoding, done) { output.push(String(chunk)); done(); },
  });
  const privateError = Object.assign(new Error("sentinel-manuscript", {
    cause: new Error("sentinel-cause"),
  }), {
    code: "23514", severity: "ERROR", detail: "sentinel-label", hint: "sentinel-title", query: "sentinel-query",
  });
  const release = vi.fn();
  const database = {
    query: pool.query.bind(pool),
    async connect() {
      return {
        release,
        async query(sql: string) {
          if (sql.startsWith("BEGIN")) return;
          if (sql === "ROLLBACK") throw privateError;
          throw privateError;
        },
      } as unknown as PoolClient;
    },
  } as Pool;
  const safeApp = buildApp({ pool: database }, log);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const headers = { "x-axis-user": "usr_sentinel", "request-id": "sentinel-request-id", authorization: "sentinel-credential" };
    const failed = await safeApp.inject({ url: "/chapters/ch_000000000001/working-state?x=sentinel-route", headers });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: { code: "internal", message: "Internal error", details: null } });
    const invalid = await safeApp.inject({ method: "POST", url: "/series", headers, payload: { title: { value: "sentinel-title" } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(release).toHaveBeenCalledWith(true);
    const serialized = output.join("");
    expect(serialized).not.toMatch(/sentinel|usr_sentinel/);
    const entries = serialized.trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.event === "request_failed")).toEqual([
      expect.objectContaining({ reqId: expect.stringMatching(/^req-/), error_class: "postgres", sqlstate: "23514", statusCode: 500 }),
    ]);
    expect(entries.filter(entry => entry.event === "request_completed").map(entry => entry.statusCode)).toEqual([500, 400]);
    expect(report.mock.calls).toEqual([[JSON.stringify({ event: "database_rollback_failed", error_class: "postgres", sqlstate: "23514" })]]);
  } finally {
    report.mockRestore();
    await safeApp.close();
  }
});

test("startup diagnostics omit invalid configuration values", () => {
  const failed = spawnSync(process.execPath, ["dist/src/main.js"], {
    env: { ...process.env, DATABASE_URL: "postgresql://axis@127.0.0.1:55432/test",
      AXIS_ALLOWED_CLIENT_ORIGINS: "sentinel-origin" }, encoding: "utf8",
  });
  expect(failed.status).toBe(1);
  expect(failed.stderr).not.toContain("sentinel-origin");
  expect(JSON.parse(failed.stderr)).toMatchObject({ event: "startup_failed", error_class: "unexpected" });
});
