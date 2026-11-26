import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { findOwnedChapter } from "../corpus/repo.js";
import { AppError } from "../errors.js";
import { pullBackChapter } from "./pullback.js";

const pullBackPath = "/chapters/:id(^[\\s\\S]{1,100}$)/pull-back";

export function registerPullBackRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.post<{ Params: { id: string } }>(pullBackPath, async (request, reply) => {
    const ownerId = requireUser(request);
    const { id } = request.params;
    const chapter = id.length > 64 || id.includes("\u0000") ? null : await findOwnedChapter(pool, ownerId, id);
    if (!chapter) throw new AppError(404, "not_found", "Chapter not found");

    const result = await pullBackChapter(pool, chapter);
    if (!result) throw new AppError(409, "not_in_book", "Chapter has no Book version", null);
    return reply.code(200).send(result);
  });
}
