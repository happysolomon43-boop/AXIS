import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { captureChapterSnapshot, uuidPattern, type CaptureRequest } from "./capture.js";

const path = "/chapters/:id(^[\\s\\S]{1,100}$)/snapshots";
function guard(id: string) {
  if (id.length > 64 || id.includes("\u0000")) throw new AppError(404, "not_found", "Chapter not found");
}
function redact(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new AppError(500, "internal", "Internal error");
}
export function registerSnapshotCaptureRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.post<{ Params: { id: string }; Body: CaptureRequest }>(path, {
    bodyLimit: 8388608,
    schema: { body: { type: "object", additionalProperties: false,
      required: ["request_id", "content", "base_version", "base_revision"],
      properties: {
        request_id: { type: "string", pattern: uuidPattern, minLength: 36, maxLength: 36 },
        content: { type: "string" },
        base_version: { type: "string", pattern: "^ver_[0-9a-f]{12}$", minLength: 16, maxLength: 16 },
        base_revision: { type: "integer", minimum: 0, maximum: 2147483647 },
        name: { type: "string" }
      } } },
  }, async (request, reply) => {
    const actor = requireUser(request);
    const { id } = request.params;
    guard(id);
    try {
      const { status, capture } = await captureChapterSnapshot(pool, actor, id, request.body);
      return reply.header("Cache-Control", "no-store").code(status).send({ capture });
    } catch (error) { redact(error); }
  });
}
