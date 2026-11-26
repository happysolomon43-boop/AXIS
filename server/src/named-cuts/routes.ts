import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { nameSavedVersion, type NameInput } from "./repository.js";

export function registerNamedCutRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.post<{ Params: { id: string }; Body: NameInput }>("/series/:id(^[\\s\\S]{1,100}$)/named-cuts", {
    schema: { body: { type: "object", additionalProperties: false,
      required: ["kind", "chapter_id", "version_id"], properties: {
        kind: { type: "string", enum: ["snapshot"] },
        chapter_id: { type: "string", pattern: "^ch_[0-9a-f]{12}$" },
        version_id: { type: "string", pattern: "^ver_[0-9a-f]{12}$" },
        name: { type: "string" },
      } } },
  }, async (request, reply) => {
    const owner = requireUser(request);
    const { id } = request.params;
    if (id.length > 64 || id.includes("\u0000")) throw new AppError(404, "not_found", "Series not found");
    try {
      const { status, snapshot } = await nameSavedVersion(pool, owner, id, request.body);
      return reply.header("Cache-Control", "no-store").code(status).send({ snapshot });
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Database errors can contain the label in their detail or query parameters.
      throw new AppError(500, "internal", "Internal error");
    }
  });
}
