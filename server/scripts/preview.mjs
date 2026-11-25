import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApp } from "../dist/src/app.js";
import { runMigrations } from "../dist/src/db/migrate.js";
import { createPool } from "../dist/src/db/pool.js";

const actor = "usr_alice";
const cookieName = "__Host-axis-d09";
const sessionSeconds = 60 * 60 * 24;
const password = process.env.AXIS_PREVIEW_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
const port = Number(process.env.PORT ?? "10000");

if (!password || password.length < 24) throw new Error("Set AXIS_PREVIEW_PASSWORD to a random password of at least 24 characters");
if (!databaseUrl) throw new Error("Set DATABASE_URL to the preview database");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid preview port");

const digest = (value) => createHash("sha256").update(value).digest();
const equal = (left, right) => timingSafeEqual(digest(left), digest(right));
const signature = (expires) => createHmac("sha256", password).update(`AXIS D09 preview:${expires}`).digest("base64url");

function signedIn(request) {
  const session = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const [expires, mac] = session?.split(".") ?? [];
  return /^\d{10}$/.test(expires ?? "") && !!mac && Number(expires) > Date.now() / 1000 &&
    equal(session, `${expires}.${signature(expires)}`);
}

function signInPage(invalid = false) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AXIS D09 preview</title>
<style>
  body { margin: 0; padding: 24px; min-height: calc(100vh - 48px); display: grid; place-items: center;
         background: #ecebe6; color: #1b1c1e; font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(100%, 360px); }
  h1 { font-size: 27px; }
  label { display: block; margin-bottom: 6px; }
  input, button { box-sizing: border-box; min-height: 44px; border-radius: 5px; font: inherit; }
  input { width: 100%; padding: 8px 12px; border: 1px solid #62656a; background: #fcfcfa; color: inherit; }
  button { margin-top: 12px; padding: 8px 18px; border: 1px solid #1b1c1e; background: #1b1c1e; color: #fcfcfa; }
</style>
<main>
  <h1>AXIS D09 preview</h1>
  <form action="/sign-in" method="post">
    <label for="password">Preview password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    ${invalid ? '<p role="alert">That password did not match.</p>' : ""}
    <button type="submit">Open AXIS</button>
  </form>
</main>
</html>`;
}

function send(response, status, type, body) {
  response.writeHead(status, { "Content-Type": type });
  response.end(body);
}

async function signIn(request, response) {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
    send(response, 415, "text/plain; charset=utf-8", "Use the preview sign-in form.");
    return;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 2048) {
      send(response, 413, "text/plain; charset=utf-8", "Sign-in request is too large.");
      request.resume();
      return;
    }
    chunks.push(chunk);
  }
  const supplied = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("password");
  if (!equal(supplied ?? "", password)) {
    send(response, 401, "text/html; charset=utf-8", signInPage(true));
    return;
  }
  const expires = Math.floor(Date.now() / 1000) + sessionSeconds;
  response.writeHead(303, {
    Location: "/",
    "Set-Cookie": `${cookieName}=${expires}.${signature(expires)}; Path=/; Max-Age=${sessionSeconds}; Secure; HttpOnly; SameSite=Lax`,
  });
  response.end();
}

async function seed(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(41002)");
    const existing = await client.query("SELECT 1 FROM series WHERE owner_id = $1 LIMIT 1", [actor]);
    if (existing.rowCount === 0) {
      const title = "Ashfall";
      const { rows: [series] } = await client.query(
        "INSERT INTO series (owner_id, title) VALUES ($1, $2) RETURNING id", [actor, title],
      );
      const { rows: [book] } = await client.query(
        "INSERT INTO books (series_id, title, ordinal, author_id) VALUES ($1, $2, 1, $3) RETURNING id",
        [series.id, title, actor],
      );
      await client.query("SELECT commit_inputs($1, 'corpus', $2, 'chapter.create', $3::jsonb)", [
        series.id, actor, JSON.stringify([
          { kind: "chapter", book_id: book.id },
          {
            kind: "chapter_version", chapter_ref: 0, source: "draft_edit",
            content: "# The Lantern\n\nMira crossed the quay before dawn.\n\n---\n\nA lantern burned in the empty house.",
          },
          {
            kind: "chapter_version", chapter_ref: 0, source: "send", activate: true,
            content: "# The Lantern\n\nMira crossed the quay after dawn.\n\n---\n\nA lantern burned in the empty house.",
          },
        ]),
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const pool = createPool(databaseUrl);
const app = buildApp({ pool });
const web = createServer({ headersTimeout: 10000, requestTimeout: 30000 });
try {
  const clientDist = new URL("../../client/dist/", import.meta.url);
  const index = await readFile(new URL("index.html", clientDist));
  const assets = new Map();
  const assetDir = new URL("assets/", clientDist);
  for (const name of await readdir(assetDir)) {
    const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : null;
    if (type) assets.set(`/assets/${name}`, { type: `${type}; charset=utf-8`, body: await readFile(new URL(name, assetDir)) });
  }

  await runMigrations(pool, fileURLToPath(new URL("../db/migrations/", import.meta.url)));
  await seed(pool);
  await app.ready();

  web.on("request", (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    const [path] = request.url?.split("?") ?? [];

    if (request.method === "GET" && path === "/health") {
      send(response, 200, "text/plain; charset=utf-8", "ready");
      return;
    }
    if (request.method === "POST" && path === "/sign-in") {
      void signIn(request, response).catch(() => {
        if (!response.headersSent) send(response, 400, "text/plain; charset=utf-8", "Invalid sign-in request.");
      });
      return;
    }
    if (!signedIn(request)) {
      if (request.method === "GET" && path === "/") {
        send(response, 200, "text/html; charset=utf-8", signInPage());
      } else {
        send(response, 401, "text/plain; charset=utf-8", "Sign in to the AXIS preview first.");
      }
      return;
    }
    if (path?.startsWith("/api/")) {
      request.url = request.url.slice(4);
      request.headers["x-axis-user"] = actor;
      app.routing(request, response);
      return;
    }
    const asset = assets.get(path);
    if (request.method === "GET" && (path === "/" || asset)) {
      send(response, 200, asset?.type ?? "text/html; charset=utf-8", asset?.body ?? index);
    } else {
      send(response, 404, "text/plain; charset=utf-8", "Page not found.");
    }
  });

  await new Promise((resolve, reject) => {
    web.once("error", reject);
    web.listen(port, "0.0.0.0", () => {
      web.off("error", reject);
      resolve();
    });
  });
  console.log("AXIS D09 preview is ready");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise((resolve) => web.close(resolve));
    await app.close();
    await pool.end();
  };
  const onSignal = () => {
    void stop().catch(() => { process.exitCode = 1; });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
} catch (error) {
  await app.close();
  await pool.end();
  throw error;
}
