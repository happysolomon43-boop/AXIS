import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const env = { ...process.env, PORT: "3000", AXIS_API_URL: "http://localhost:3000" };

function start(label, command, args, cwd) {
  const proc = spawn(command, args, { cwd, env, stdio: "inherit", detached: true });
  const done = new Promise((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
    proc.once("error", (error) => resolve({ error: error.message }));
  });
  return { label, proc, done };
}

async function ready(service, url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!service.proc.pid || service.proc.exitCode !== null || service.proc.signalCode !== null) {
      throw new Error(`${service.label} exited before serving ${url}`);
    }
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // The process may still be starting.
    }
    await delay(200);
  }
  throw new Error(`${service.label} did not become ready at ${url}`);
}

async function request(step, method, path, status, body) {
  try {
    const response = await fetch(`http://localhost:4173/api${path}`, {
      method,
      headers: {
        "X-Axis-User": "usr_alice",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    console.log(`Step ${step} ${method} ${path}: ${status}`);
    return data;
  } catch (error) {
    throw new Error(`Step ${step} ${method} ${path} failed`, { cause: error });
  }
}

function vitePid(npmPid) {
  // Signal Vite itself so npm and its shell can report Vite's real exit code.
  const children = new Map();
  const rows = execFileSync("ps", ["-ww", "-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  for (const row of rows.trim().split("\n")) {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, parent, command] = match;
    const list = children.get(Number(parent)) ?? [];
    list.push({ pid: Number(pid), command });
    children.set(Number(parent), list);
  }
  const pending = [...(children.get(npmPid) ?? [])];
  for (const { pid, command } of pending) {
    if (/(?:^|\/)node(?:js)?\s+\S*\bvite\s+preview(?:\s|$)/.test(command)) return pid;
    pending.push(...(children.get(pid) ?? []));
  }
  throw new Error("Vite preview process was not found under npm");
}

function signal(pid, name) {
  if (!pid) return;
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

const server = start("AXIS server", process.execPath, ["dist/src/main.js"], "server");
const preview = start("Vite preview", "npm", ["run", "preview", "--", "--port", "4173", "--strictPort"], "client");

let previewPid;
let failure;
try {
  await ready(server, "http://localhost:3000/health");
  await ready(preview, "http://localhost:4173/");
  previewPid = vitePid(preview.proc.pid);

  const series = await request(1, "POST", "/series", 201, { title: "Ashfall" });
  assert.ok(series.books[0]?.id, "Step 1 first Book ID");
  const first = await request(2, "POST", `/books/${series.books[0].id}/chapters`, 201, { content: "# Title\n\nHello" });
  assert.ok(first.chapter?.id && first.version?.id, "Step 2 chapter and version IDs");
  const path = `/chapters/${first.chapter.id}`;
  const draftPath = `${path}/draft`;
  const v1 = first.version.id;
  const input = { content: "# Title\n\nHello!", base_version: v1, base_revision: 0 };

  assert.equal((await request(3, "GET", draftPath, 200)).draft, null, "Step 3 no head");
  assert.equal((await request(4, "PUT", draftPath, 200, input)).revision, 1, "Step 4 first revision");
  assert.deepEqual((await request(5, "GET", draftPath, 200)).draft, {
    base_version: v1, revision: 1, content: input.content,
    blocks: [{ ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "Hello!" }],
  }, "Step 5 head payload");
  const duplicate = await request(6, "PUT", draftPath, 409, input);
  assert.deepEqual(duplicate.error, {
    code: "conflict", message: "Draft is out of date",
    details: { reason: "revision", current_version: v1, current_revision: 1 },
  }, "Step 6 revision conflict");
  const saved = await request(7, "POST", `${path}/versions`, 201, { content: input.content, parent_version: v1 });
  assert.equal(saved.version?.version_no, 2, "Step 7 version number");
  assert.equal((await request(8, "GET", draftPath, 200)).draft, null, "Step 8 cleared head");
  const stale = await request(9, "PUT", draftPath, 409, input);
  assert.deepEqual(stale.error, {
    code: "conflict", message: "Draft is out of date",
    details: { reason: "version", current_version: saved.version.id, current_revision: 0 },
  }, "Step 9 version conflict");
} catch (error) {
  failure = error;
} finally {
  const services = [server, preview];
  const guard = setTimeout(() => {
    for (const { proc } of services) if (proc.pid) signal(-proc.pid, "SIGKILL");
  }, 10000);
  try {
    signal(server.proc.pid, "SIGTERM");
    signal(previewPid ?? (preview.proc.pid ? -preview.proc.pid : undefined), "SIGTERM");
    const exits = await Promise.all(services.map(({ done }) => done));
    for (const [index, exit] of exits.entries()) {
      const label = `Step 10 ${services[index].label}`;
      assert.deepEqual(exit, { code: 0, signal: null }, label);
      console.log(`${label}: exited 0 after SIGTERM`);
    }
  } catch (error) {
    failure ??= error;
  } finally {
    clearTimeout(guard);
  }
}
if (failure) throw failure;
console.log("D07 live smoke passed");
