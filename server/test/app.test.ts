import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
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
