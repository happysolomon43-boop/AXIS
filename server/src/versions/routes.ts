import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { findOwnedChapter } from "../corpus/repo.js";
import { AppError } from "../errors.js";
import { getVersionText } from "./repository.js";

const versionPath = "/chapters/:id(^[\\s\\S]{1,100}$)/versions/:versionId(^[\\s\\S]{1,100}$)";

function malformedId(id: string): boolean {
  return id.length > 64 || id.includes("\u0000");
}

export function registerVersionRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.get<{ Params: { id: string; versionId: string } }>(versionPath, async (request) => {
    const ownerId = requireUser(request);
    const { id, versionId } = request.params;
    const chapter = malformedId(id) ? null : await findOwnedChapter(pool, ownerId, id);
    if (!chapter) throw new AppError(404, "not_found", "Chapter not found");

    const result = malformedId(versionId) ? null : await getVersionText(pool, chapter, versionId);
    if (!result) throw new AppError(404, "not_found", "Version not found");
    return result;
  });
}
