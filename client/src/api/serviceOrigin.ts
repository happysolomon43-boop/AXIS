import { ConfigError } from "../identity";

export function readServiceOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.hostname && !raw.includes("*") && raw === url.origin) return raw;
  } catch {
    // Reject rather than normalize malformed configuration.
  }
  throw new ConfigError("The service address is invalid.");
}

export function serviceTarget(origin: string | null, path: string): { url: string; options: RequestInit } {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\x00-\x1f\x7f]/.test(path)) {
    throw new ConfigError("Invalid service path.");
  }
  if (origin === null) return { url: "/api" + path, options: {} };
  // Protect the exported boundary even when called independently of the resolver.
  if (readServiceOrigin(origin) === null) throw new ConfigError("The service address is invalid.");
  return { url: origin + path, options: { mode: "cors", credentials: "omit", redirect: "error" } };
}
