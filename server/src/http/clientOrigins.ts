export function readClientOrigins(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error();
    const origins = new Set<string>();
    for (const origin of value) {
      if (typeof origin !== "string" || !validOrigin(origin)) throw new Error();
      origins.add(origin);
    }
    return origins;
  } catch {
    throw new Error("Invalid AXIS_ALLOWED_CLIENT_ORIGINS");
  }
}

function validOrigin(raw: string): boolean {
  if (raw === "capacitor://localhost" || raw === "tauri://localhost") return true;
  if (raw.includes("*")) return false;
  const url = new URL(raw);
  if (!url.hostname || raw !== url.origin) return false;
  if (url.protocol === "https:") return true;
  const host = url.hostname;
  return url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1"
    || host === "[::1]" || /^(?:[^.]+\.)+localhost$/.test(host));
}
