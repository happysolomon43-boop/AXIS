import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { uuidPattern } from "../named-cuts/capture.js";
import { writeChapter, type ChapterWriteBody } from "../writes/ordinary.js";
import { getWriteReceipt } from "../writes/receipts.js";
import {
  activateVersion, createChapterWithFirstVersion, findOwnedBook,
  findOwnedChapter, getChapterDetail, getChapterHistory, listBookChapters,
  type BookChapters,
} from "./repo.js";
import { checkContent } from "./validate.js";

type CreateChapterBody = { content: string; source?: "draft_edit" | "import" };

// Apply the 100-character router limit only to the Corpus routes.
const bookChaptersPath = "/books/:id(^[\\s\\S]{1,100}$)/chapters";
const chapterPath = "/chapters/:id(^[\\s\\S]{1,100}$)";
type ChapterParams = { id: string };
const chapterWriteBody = {
  type: "object",
  required: ["content", "request_id", "base_version", "base_revision"],
  additionalProperties: false,
  properties: {
    content: { type: "string" },
    request_id: { type: "string", pattern: uuidPattern, minLength: 36, maxLength: 36 },
    base_version: { type: "string", minLength: 1, maxLength: 64 },
    base_revision: { type: "integer", minimum: 0, maximum: 2147483647 },
    parent_version: { type: "string" },
    hints: { type: ["array", "null"] },
  },
};

function isMalformedId(id: string): boolean {
  return id.length > 64 || id.includes("\u0000");
}

function chapterNotFound(): AppError {
  return new AppError(404, "not_found", "Chapter not found");
}

async function requireOwnedChapter(pool: Pool, ownerId: string, id: string) {
  if (isMalformedId(id)) throw chapterNotFound();
  const chapter = await findOwnedChapter(pool, ownerId, id);
  if (!chapter) throw chapterNotFound();
  return chapter;
}

function bookNotFound(): AppError {
  return new AppError(404, "not_found", "Book not found");
}

export function registerCorpusRoutes(app: FastifyInstance, { pool }: Deps): void {
  app.post<{ Params: { id: string }; Body: CreateChapterBody }>(
    bookChaptersPath,
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
      if (isMalformedId(id)) throw bookNotFound();

      const book = await findOwnedBook(pool, ownerId, id);
      if (!book) throw bookNotFound();

      const { content, source = "draft_edit" } = request.body;
      checkContent(content);
      const created = await createChapterWithFirstVersion(pool, ownerId, book, content, source);
      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: ChapterParams }>(chapterPath, async (request) => {
    const ownerId = requireUser(request);
    const { id } = request.params;
    if (isMalformedId(id)) throw chapterNotFound();

    const detail = await getChapterDetail(pool, id, ownerId);
    if (!detail) throw chapterNotFound();
    return detail;
  });

  for (const [path, operation] of [["versions", "save"], ["send", "send"], ["keep-mine", "keep_mine"]] as const) {
    const properties = {
      ...chapterWriteBody.properties,
      ...(operation === "save" ? { source: { type: "string", enum: ["draft_edit", "import"] } } : {}),
    };
    app.post<{ Params: ChapterParams; Body: ChapterWriteBody }>(
      chapterPath + "/" + path,
      {
        bodyLimit: 8388608,
        schema: { body: { ...chapterWriteBody, properties,
          required: operation === "keep_mine" ? [...chapterWriteBody.required, "parent_version"] : chapterWriteBody.required } },
      },
      async (request, reply) => {
        const ownerId = requireUser(request);
        const chapter = await requireOwnedChapter(pool, ownerId, request.params.id);
        const { status, result } = await writeChapter(pool, ownerId, chapter, operation, request.body);
        return reply.header("Cache-Control", "no-store").code(status).send(result);
      },
    );
  }

  app.get<{ Params: ChapterParams & { requestId: string } }>(
    chapterPath + "/write-receipts/:requestId(^[\\s\\S]{1,100}$)",
    async (request, reply) => {
      const { id, requestId } = request.params;
      const receipt = await getWriteReceipt(pool, requireUser(request), id, requestId);
      return reply.header("Cache-Control", "no-store").send({ receipt });
    },
  );

  app.post<{ Params: ChapterParams; Body: { version_id: string | null } }>(
    chapterPath + "/activate",
    {
      schema: {
        body: {
          type: "object",
          required: ["version_id"],
          additionalProperties: false,
          properties: { version_id: { type: ["string", "null"] } },
        },
      },
    },
    async (request) => {
      const ownerId = requireUser(request);
      const chapter = await requireOwnedChapter(pool, ownerId, request.params.id);
      const { version_id } = request.body;
      if (version_id !== null && isMalformedId(version_id)) {
        throw new AppError(404, "not_found", "Version not found");
      }
      return activateVersion(pool, ownerId, chapter, version_id);
    },
  );

  app.get<{ Params: ChapterParams; Reply: BookChapters }>(bookChaptersPath, async (request) => {
    const ownerId = requireUser(request);
    const { id } = request.params;
    if (isMalformedId(id)) throw bookNotFound();

    const chapters = await listBookChapters(pool, id, ownerId);
    if (!chapters) throw bookNotFound();
    return { chapters };
  });

  app.get<{ Params: ChapterParams }>(chapterPath + "/history", async (request, reply) => {
    const ownerId = requireUser(request);
    const { id } = request.params;
    if (isMalformedId(id)) throw chapterNotFound();

    const history = await getChapterHistory(pool, id, ownerId);
    if (!history) throw chapterNotFound();
    return reply.header("Cache-Control", "no-store").send(history);
  });
}
