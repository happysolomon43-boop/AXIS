import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { createSeriesWithFirstBook, getSeriesTree } from "./repo.js";

type CreateSeriesBody = { title: string; book_title?: string };

function titleFor(value: string, path: "/title" | "/book_title"): string {
  const title = value.trim();
  if (!title || [...title].length > 200 || title.includes("\u0000")) {
    throw new AppError(400, "validation_failed", "Request validation failed", {
      errors: [{ path, message: "must be 1 to 200 characters and must not contain NUL" }],
    });
  }
  return title;
}

function seriesNotFound(): AppError {
  return new AppError(404, "not_found", "Series not found");
}

export function registerSeriesRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.post<{ Body: CreateSeriesBody }>(
    "/series",
    {
      schema: {
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            book_title: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const ownerId = requireUser(request);
      const title = titleFor(request.body.title, "/title");
      const bookTitle = request.body.book_title === undefined
        ? title
        : titleFor(request.body.book_title, "/book_title");
      const tree = await createSeriesWithFirstBook(pool, ownerId, title, bookTitle);
      return reply.code(201).send(tree);
    },
  );

  app.get<{ Params: { id: string } }>("/series/:id", async (request) => {
    const { id } = request.params;
    if (id.length > 64 || id.includes("\u0000")) throw seriesNotFound();

    const tree = await getSeriesTree(pool, requireUser(request), id);
    if (!tree) throw seriesNotFound();
    return tree;
  });
}
