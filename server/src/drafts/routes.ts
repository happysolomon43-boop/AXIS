import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { findOwnedChapter } from "../corpus/repo.js";
import { checkContent } from "../corpus/validate.js";
import { AppError } from "../errors.js";
import { readChapterSync } from "../sync/read.js";
import { getDraft, putDraft, type DraftInput } from "./repository.js";

const draftPath = "/chapters/:id(^[\\s\\S]{1,100}$)/draft";
type Params = { id: string };

async function ownedChapter(pool: Pool, owner: string, id: string) {
  const chapter = id.length > 64 || id.includes("\u0000") ? null : await findOwnedChapter(pool, owner, id);
  if (!chapter) throw new AppError(404, "not_found", "Chapter not found");
  return chapter;
}

export function registerDraftRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.put<{ Params: Params; Body: DraftInput }>(
    draftPath,
    {
      bodyLimit: 8388608,
      schema: {
        body: {
          type: "object",
          required: ["content", "base_version", "base_revision"],
          additionalProperties: false,
          properties: {
            content: { type: "string" },
            base_version: { type: "string", minLength: 1, maxLength: 64 },
            base_revision: { type: "integer", minimum: 0, maximum: 2147483647 },
          },
        },
      },
    },
    async (request) => {
      const chapter = await ownedChapter(pool, requireUser(request), request.params.id);
      checkContent(request.body.content);
      return putDraft(pool, chapter, request.body);
    },
  );

  app.get<{ Params: Params }>(draftPath, async (request, reply) => {
    const chapter = await ownedChapter(pool, requireUser(request), request.params.id);
    const url = request.raw.url ?? "";
    const separator = url.indexOf("?");
    const views = new URLSearchParams(separator === -1 ? "" : url.slice(separator + 1)).getAll("view");
    if (views.length === 1 && views[0] === "sync") {
      const sync = await readChapterSync(pool, chapter.id);
      return reply.header("Cache-Control", "no-store").code(200).send({ sync });
    }
    return getDraft(pool, chapter);
  });
}
