import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const methods = new Set(["GET", "POST", "PUT"]);
const requestedHeaders = new Set(["content-type", "x-axis-user"]);
const originField = "origin";
const methodField = "access-control-request-method";
const headersField = "access-control-request-headers";

function fields(request: FastifyRequest, name: string): string[] {
  const raw = request.raw.rawHeaders ?? [];
  const found: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === name) found.push(raw[i + 1]!);
  }
  if (found.length) return found;
  const value = request.headers[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function single(values: string[]): string | undefined {
  return values.length === 1 && !values[0]!.includes(",") ? values[0] : undefined;
}

function isPreflight(request: FastifyRequest): boolean {
  return request.method === "OPTIONS" && fields(request, originField).length > 0
    && fields(request, methodField).length > 0;
}

function vary(request: FastifyRequest, reply: FastifyReply): void {
  const previous = reply.getHeader("vary");
  const tokens = (Array.isArray(previous) ? previous.join(",") : String(previous ?? ""))
    .split(",").map(token => token.trim()).filter(Boolean);
  if (tokens.length === 1 && tokens[0] === "*") return;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const token of [...tokens, "Origin", ...(isPreflight(request)
    ? ["Access-Control-Request-Method", "Access-Control-Request-Headers"] : [])]) {
    const key = token.toLowerCase();
    if (!seen.has(key)) { seen.add(key); merged.push(token); }
  }
  reply.header("Vary", merged.join(", "));
}

// Returns true only when negotiation has completed the response.
export function applyCors(request: FastifyRequest, reply: FastifyReply, origins: ReadonlySet<string>): boolean {
  vary(request, reply);
  const origin = single(fields(request, originField));
  const allowed = origin !== undefined && origins.has(origin);
  if (isPreflight(request)) {
    const method = single(fields(request, methodField));
    const names = fields(request, headersField);
    const validNames = names.length === 0 || [...new Set(names.join(",").split(",")
      .map(name => name.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[A-Z]/g, c => c.toLowerCase())))]
      .every(name => requestedHeaders.has(name));
    if (!allowed || method === undefined || !methods.has(method) || !validNames) {
      reply.code(404).send({ error: { code: "not_found", message: "Route not found", details: null } });
      return true;
    }
    reply.header("Access-Control-Allow-Origin", origin!)
      .header("Access-Control-Allow-Methods", "GET, POST, PUT")
      .header("Access-Control-Allow-Headers", "Content-Type, X-Axis-User")
      .header("Access-Control-Max-Age", "0").header("Cache-Control", "no-store").code(204).send();
    return true;
  }
  if (allowed && methods.has(request.method)) reply.header("Access-Control-Allow-Origin", origin!);
  return false;
}

export function registerCors(app: FastifyInstance, origins: ReadonlySet<string>): void {
  if (!origins.size) return;
  app.addHook("onRequest", async (request, reply) => {
    if (applyCors(request, reply, origins)) return reply;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    vary(request, reply);
    return payload;
  });
}
