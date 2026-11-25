import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
  }
}

const userIdPattern = /^usr_[a-z0-9]{2,32}$/;

function authRequired(): AppError {
  return new AppError(401, "auth_required", "Missing or invalid X-Axis-User header");
}

export function identifyRequest(request: FastifyRequest): void {
  if (request.url.split("?", 1)[0] === "/health") return;

  const header = request.headers["x-axis-user"];
  if (typeof header !== "string" || !userIdPattern.test(header)) {
    throw authRequired();
  }
  request.userId = header;
}

export function registerIdentity(app: FastifyInstance): void {
  app.decorateRequest("userId", null);
  app.addHook("onRequest", async (request) => {
    identifyRequest(request);
  });
}

export function requireUser(request: FastifyRequest): string {
  if (!request.userId) throw authRequired();
  return request.userId;
}
