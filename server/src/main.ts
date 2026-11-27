import { reportFailure } from "./logging.js";
import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";

function readConfig(): { url: string; port: number } {
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) throw new Error("DATABASE_URL is required");

  const rawPort = process.env.PORT ?? "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return { url, port };
}

async function start(): Promise<void> {
  const { url, port } = readConfig();
  const pool = createPool(url);
  try {
    const app = buildApp({ pool });
    await app.listen({ host: "0.0.0.0", port });

    let closing = false;
    async function shutdown(): Promise<void> {
      if (closing) return;
      closing = true;
      try {
        await app.close();
      } finally {
        await pool.end();
      }
      process.exitCode = 0;
    }

    const onSignal = () => { void shutdown().catch((error: unknown) => {
      reportFailure("shutdown_failed", error);
      process.exitCode = 1;
    }); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

try {
  await start();
} catch (error) {
  reportFailure("startup_failed", error);
  process.exitCode = 1;
}
