/// <reference lib="es2024.string" />

import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { createChapterWithFirstVersion, findOwnedBook, getChapterDetail } from "./repo.js";

type CreateChapterBody = { content: string; source?: "draft_edit" | "import" };

const maxContentLength = 1_000_000;

function exceedsContentLimit(content: string): boolean {
  if (content.length <= maxContentLength) return false;
  let length = 0;
  for (const _ of content) {
    length += 1;
    if (length > maxContentLength) return true;
  }
  return false;
}

function validateContent(content: string): void {
  if (content.length > 2 * maxContentLength || !content.isWellFormed() ||
      content.includes("\u0000") || exceedsContentLimit(content)) {
    throw new AppError(400, "validation_failed", "Request validation failed", {
      errors: [{
        path: "/content",
        message: "must be at most 1000000 characters and must not contain NUL or unpaired surrogates",
      }],
    });
  }
}

function bookNotFound(): AppError {
  return new AppError(404, "not_found", "Book not found");
}

export function registerCorpusRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.post<{ Params: { id: string }; Body: CreateChapterBody }>(
    // Keep the Corpus parameter limit independent of D01's Series route.
    "/books/:id(^[\\s\\S]{1,100}$)/chapters",
    {
      bodyLimit: 8388608,
      schema: {
        body: {
          type: "object",
          required: ["content"],
          additionalProperties: false,
          properties: {
            content: { type: "string" },
            source: { type: "string", enum: ["draft_edit", "import"] },
          },
        },
      },
    },
    async (request, reply) => {
      const ownerId = requireUser(request);
      const { id } = request.params;
      if (id.length > 64 || id.includes("\u0000")) throw bookNotFound();

      const book = await findOwnedBook(pool, ownerId, id);
      if (!book) throw bookNotFound();

      const { content, source = "draft_edit" } = request.body;
      validateContent(content);
      const created = await createChapterWithFirstVersion(pool, ownerId, book, content, source);
      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: { id: string } }>("/chapters/:id(^[\\s\\S]{1,100}$)", async (request) => {
    const ownerId = requireUser(request);
    const { id } = request.params;
    if (id.length > 64 || id.includes("\u0000")) {
      throw new AppError(404, "not_found", "Chapter not found");
    }

    const detail = await getChapterDetail(pool, id, ownerId);
    if (!detail) throw new AppError(404, "not_found", "Chapter not found");
    return detail;
  });
}
