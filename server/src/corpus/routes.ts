import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Deps } from "../app.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { readChapterSync } from "../sync/read.js";
import type { ChapterSync } from "../sync/state.js";
import {
  activateVersion, appendVersion, createChapterWithFirstVersion, findOwnedBook,
  findOwnedChapter, getChapterDetail, getChapterHistory, listBookChapters, sendChapter,
  type BookChapters, type VersionWritten,
} from "./repo.js";
import { checkContent, checkHintsText, invalidParentVersion } from "./validate.js";

type CreateChapterBody = { content: string; source?: "draft_edit" | "import" };

// Apply the 100-character router limit only to the Corpus routes.
const bookChaptersPath = "/books/:id(^[\\s\\S]{1,100}$)/chapters";
const chapterPath = "/chapters/:id(^[\\s\\S]{1,100}$)";
type ChapterParams = { id: string };
type ChapterVersionBody = { content: string; parent_version?: string; hints?: unknown[] | null };
export type VersionSaved = VersionWritten & { sync: ChapterSync };

const chapterWriteBody = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" },
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

function checkVersionBody({ content, hints, parent_version }: ChapterVersionBody): void {
  checkContent(content);
  checkHintsText(hints);
  if (parent_version !== undefined && (parent_version === "" || isMalformedId(parent_version))) {
    throw invalidParentVersion();
  }
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

  app.post<{ Params: ChapterParams; Body: ChapterVersionBody & { source?: "draft_edit" | "import" } }>(
    chapterPath + "/versions",
    {
      bodyLimit: 8388608,
      schema: {
        body: {
          ...chapterWriteBody,
          properties: {
            ...chapterWriteBody.properties,
            source: { type: "string", enum: ["draft_edit", "import"] },
          },
        },
      },
    },
    async (request, reply) => {
      const ownerId = requireUser(request);
      const chapter = await requireOwnedChapter(pool, ownerId, request.params.id);
      checkVersionBody(request.body);
      const { source = "draft_edit", ...input } = request.body;
      const result = await appendVersion(pool, ownerId, chapter, { ...input, source });
      const sync = await readChapterSync(pool, chapter.id);
      const saved: VersionSaved = { ...result, sync };
      return reply.code(201).send(saved);
    },
  );

  app.post<{ Params: ChapterParams; Body: ChapterVersionBody }>(
    chapterPath + "/send",
    { bodyLimit: 8388608, schema: { body: chapterWriteBody } },
    async (request, reply) => {
      const ownerId = requireUser(request);
      const chapter = await requireOwnedChapter(pool, ownerId, request.params.id);
      checkVersionBody(request.body);
      return reply.code(201).send(await sendChapter(pool, ownerId, chapter, request.body));
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

  app.get<{ Params: ChapterParams }>(chapterPath + "/history", async (request) => {
    const ownerId = requireUser(request);
    const { id } = request.params;
    if (isMalformedId(id)) throw chapterNotFound();

    const history = await getChapterHistory(pool, id, ownerId);
    if (!history) throw chapterNotFound();
    return history;
  });
}
