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

export async function request(step, method, path, status, body, user = "usr_alice") {
  try {
    const response = await fetch(`http://localhost:4173/api${path}`, {
      method,
      headers: {
        "X-Axis-User": user,
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

export async function withPreview(check) {
  const server = start("AXIS server", process.execPath, ["dist/src/main.js"], "server");
  const preview = start("Vite preview", "npm", ["run", "preview", "--", "--port", "4173", "--strictPort"], "client");

  let previewPid;
  let failure;
  try {
    await ready(server, "http://localhost:3000/health");
    await ready(preview, "http://localhost:4173/");
    previewPid = vitePid(preview.proc.pid);

    await check();
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
}
