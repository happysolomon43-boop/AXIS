import type { Pool, PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makePool, resetDb } from "./helpers.js";
import { book, expectedTrace, origin, series } from "./connectionFixtures.js";

const pool = makePool();
const alice = { origin, "x-axis-user": "usr_alice" };
const denied = { error: { code: "not_found", message: "Route not found", details: null } };
let app: FastifyInstance;
beforeEach(async () => {
  await resetDb(pool);
  await pool.query("INSERT INTO series (id,owner_id,title,genre_rubric_id,foundation) VALUES ($1,$2,$3,NULL,'{}')", [series.id, series.owner_id, series.title]);
  await pool.query("INSERT INTO books (id,series_id,title,status,ordinal,author_id,language,label) VALUES ($1,$2,$3,'drafting',1,$4,'English',NULL)", [book.id, series.id, book.title, book.author_id]);
  vi.stubEnv("AXIS_ALLOWED_CLIENT_ORIGINS", JSON.stringify([origin]));
  app = buildApp({ pool });
});
afterEach(async () => {
  try { vi.restoreAllMocks(); await app.close(); }
  finally { vi.unstubAllEnvs(); await resetDb(pool); }
});
afterAll(async () => { await pool.end(); });

const vary = ["origin", "access-control-request-method", "access-control-request-headers"];
function grantHeaders(headers: Record<string, unknown>) {
  return Object.keys(headers).filter(key => key.startsWith("access-control-allow-"));
}
function expectVary(headers: Record<string, unknown>, expected: string[]) {
  expect(String(headers.vary).toLowerCase().split(",").map(x => x.trim())).toEqual(expected);
}

test("AXB-0122 AC1 and AC2 negotiate any path before identity, body and SQL", async () => {
  const connect = vi.spyOn(pool, "connect");
  const query = vi.spyOn(pool, "query");
  for (const url of ["/series", "/missing"]) for (const names of ["content-type, X-Axis-User", "X-Axis-User, x-axis-user, Content-Type", ["content-type", "X-Axis-User"], undefined]) {
    const response = await app.inject({ method: "OPTIONS", url, headers: {
      origin, "access-control-request-method": "POST", ...(names === undefined ? {} : {"access-control-request-headers": names}),
    } as Record<string,string|string[]> });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers).toMatchObject({
      "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, PUT",
      "access-control-allow-headers": "Content-Type, X-Axis-User", "access-control-max-age": "0", "cache-control": "no-store",
    });
    expectVary(response.headers, vary);
  }
  const base = { origin, "access-control-request-method": "POST", "access-control-request-headers": "x-axis-user" };
  for (const invalid of [
    { origin: "https://other.example.test" }, { origin: "null" }, { origin: [origin, origin] },
    { origin: origin + ", " + origin }, { "access-control-request-method": ["POST", "POST"] },
    { "access-control-request-method": "post" }, { "access-control-request-method": "DELETE" },
    { "access-control-request-method": "" }, { "access-control-request-headers": "" },
    { "access-control-request-headers": "x-axis-user," }, { "access-control-request-headers": "authorization" },
  ]) {
    const response = await app.inject({ method: "OPTIONS", url: "/series", headers: { ...base, ...invalid } as Record<string,string|string[]> });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(denied);
    expect(grantHeaders(response.headers)).toEqual([]);
    expectVary(response.headers, vary);
  }
  const malformedBody = await app.inject({ method: "OPTIONS", url: "/series", headers: { origin, "access-control-request-method": "POST", "content-type": "application/json" }, payload: "{bad" });
  expect(malformedBody.statusCode).toBe(204);
  expect(connect).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

test("AXB-0122 AC3 and AC4 preserve actual ownership and the disabled default", async () => {
  for (const [url, headers, status, body] of [
    ["/series", { origin }, 401, { error: { code: "auth_required", message: "Missing or invalid X-Axis-User header", details: null } }],
    ["/series/" + series.id, { origin, "x-axis-user": "usr_bob" }, 404, { error: { code: "not_found", message: "Series not found", details: null } }],
    ["/series", alice, 200, { series: [series] }],
    ["/unknown", alice, 404, denied],
  ] as const) {
    const res = await app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect(grantHeaders(res.headers)).toEqual(["access-control-allow-origin"]);
    expectVary(res.headers, ["origin"]);
  }
  for (const setting of [JSON.stringify([origin]), "[]", undefined]) {
    vi.stubEnv("AXIS_ALLOWED_CLIENT_ORIGINS", setting);
    const instance = buildApp({ pool });
    try {
      for (const [method, url, headers, status] of [
        ["GET", "/health", {}, 200], ["GET", "/health", {origin}, 200],
        ["OPTIONS", "/series", {origin}, 401], ["OPTIONS", "/series", alice, 404],
        ["GET", "/series", {"x-axis-user":"usr_alice"}, 200],
        ["GET", "/series", {...alice,origin:"https://other.example.test"}, 200],
        ["GET", "/series", {...alice,origin:[origin,origin]}, 200],
        ["GET", "/series", alice, 200],
      ] as const) {
        const res = await instance.inject({method,url,headers: {...headers} as Record<string,string|string[]>});
        expect(res.statusCode).toBe(status);
        const admitted = setting === JSON.stringify([origin]) && method === "GET" && "origin" in headers && headers.origin === origin;
        expect(res.headers["access-control-allow-origin"]).toBe(admitted ? origin : undefined);
        expect(res.headers.vary).toBe(setting === JSON.stringify([origin]) ? "Origin" : undefined);
      }
    } finally { await instance.close(); }
  }
});

test("AXB-0122 preserves existing Vary tokens and a lone wildcard", async () => {
  app.get("/vary", async (_req, reply) => reply.header("Vary", "Accept-Encoding, origin, ACCEPT-ENCODING").send({ok:true}));
  app.get("/vary-star", async (_req, reply) => reply.header("Vary", "*").send({ok:true}));
  expect((await app.inject({url:"/vary",headers:alice})).headers.vary).toBe("Accept-Encoding, origin");
  expect((await app.inject({url:"/vary-star",headers:alice})).headers.vary).toBe("*");
});

test("AXB-0126 AC1 and AC2: Connection one-shot SELECT outage, exact shared trace and no writes", async () => {
  const counts = async () => (await pool.query("SELECT (SELECT count(*) FROM series) AS series, (SELECT count(*) FROM books) AS books, (SELECT count(*) FROM ledger) AS ledger, (SELECT count(*) FROM schema_migrations) AS migrations")).rows;
  const before = await counts();
  expect(before).toEqual([{series:"1",books:"1",ledger:"0",migrations:"15"}]);
  let failed = 0;
  const intercepted = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      const original = client.query.bind(client);
      const query = (async (sql: string, params?: unknown[]) => {
        if (failed === 0 && /SELECT .* FROM series WHERE owner_id = \$1/.test(sql) && params?.[0] === "usr_alice") {
          failed++;
          throw new Error("test-only outage");
        }
        return original(sql, params);
      }) as typeof client.query;
      return { query, release: client.release.bind(client) } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const instance = buildApp({ pool: intercepted });
  try {
    const actual = [];
    for (const step of expectedTrace) {
      const response = await instance.inject({method:"GET",url:step.path,headers:alice});
      actual.push({path:step.path,status:response.statusCode,origin:response.headers["access-control-allow-origin"],body:response.json()});
      expect(await counts()).toEqual(before);
    }
    expect(actual).toEqual(expectedTrace);
    expect(failed).toBe(1);
    expect((await pool.query("SELECT id,title FROM series")).rows).toEqual([{id:series.id,title:series.title}]);
    expect((await pool.query("SELECT id,title FROM books")).rows).toEqual([{id:book.id,title:book.title}]);
  } finally { await instance.close(); await resetDb(pool); }
  expect(await counts()).toEqual([{series:"0",books:"0",ledger:"0",migrations:"15"}]);
});
