import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { findOwnedChapter } from "../corpus/repo.js";
import { AppError } from "../errors.js";
import { pullBackChapter } from "./pullback.js";

const pullBackPath = "/chapters/:id(^[\\s\\S]{1,100}$)/pull-back";
type Guard = { expected_active_version_id: string };

export function registerPullBackRoutes(app: FastifyInstance, { pool }: Deps): void {
  // Fastify validates absent input as null; distinguish absence before schema validation.
  const bodyless = new WeakSet<FastifyRequest>();
  app.post<{ Params: { id: string }; Body: Guard }>(pullBackPath, {
    preValidation: async request => {
      if (request.body === undefined) {
        bodyless.add(request);
        request.body = { expected_active_version_id: "ver_000000000000" };
      }
    },
    schema: { body: { type: "object", additionalProperties: false,
      required: ["expected_active_version_id"], properties: {
        expected_active_version_id: { type: "string", pattern: "^ver_[0-9a-f]{12}$" },
      } } },
  }, async (request, reply) => {
    const ownerId = requireUser(request);
    const { id } = request.params;
    const chapter = id.length > 64 || id.includes("\u0000") ? null : await findOwnedChapter(pool, ownerId, id);
    if (!chapter) throw new AppError(404, "not_found", "Chapter not found");
    const result = await pullBackChapter(pool, chapter, ownerId, bodyless.has(request) ? undefined : request.body.expected_active_version_id);
    if (!result) throw new AppError(404, "not_found", "Chapter not found");
    return reply.code(200).send(result);
  });
}
