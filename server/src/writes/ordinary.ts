import type { Pool, PoolClient } from "pg";
import { chapterHasVersion, commitChapterRow, readActiveVersionId, type ChapterRef } from "../corpus/repo.js";
import { checkContent, checkHintsText, invalidHints, invalidParentVersion } from "../corpus/validate.js";
import { AppError } from "../errors.js";
import { commitChapterWrite, readWriteBase } from "./receipts.js";
import { insertCheckpointLabel } from "../named-cuts/checkpoint-label.js";

export type ChapterWriteBody = {
  request_id: string;
  content: string;
  base_version: string;
  base_revision: number;
  parent_version?: string;
  hints?: unknown[] | null;
  source?: "draft_edit" | "import";
};

function isNestedHint(hint: unknown): boolean {
  return Array.isArray(hint) || (
    hint !== null && typeof hint === "object" &&
    Object.values(hint).some((field) => field !== null && typeof field === "object")
  );
}

async function writeVersion(
  client: PoolClient, actor: string, chapter: ChapterRef,
  input: Pick<ChapterWriteBody, "content" | "hints"> & { parent_version: string },
  source: "draft_edit" | "import" | "send" | "reupload",
) {
  const send = source === "send" || source === "reupload";
  const { ids: [versionId] } = await commitChapterRow(
    client, actor, chapter, send ? "chapter.send" : "chapter.version.append", {
      kind: "chapter_version", chapter_id: chapter.id, content: input.content, source,
      parent_version: input.parent_version, hints: input.hints, ...(send ? { activate: true } : {}),
    },
  );
  if (!versionId) throw new Error("Chapter commit returned no version ID");
  return versionId;
}

export function writeChapter(
  pool: Pool, actor: string, chapter: ChapterRef, operation: "save" | "send" | "keep_mine", body: ChapterWriteBody,
) {
  checkContent(body.content);
  checkHintsText(body.hints);
  if (body.parent_version !== undefined && (!body.parent_version || body.parent_version.length > 64 ||
      body.parent_version.includes("\u0000"))) throw invalidParentVersion();
  if (body.base_version.includes("\u0000")) {
    throw new AppError(400, "validation_failed", "Request validation failed", {
      errors: [{ path: "/base_version", message: "must not contain NUL" }],
    });
  }
  if (body.hints?.some(isNestedHint)) throw invalidHints();

  const { request_id, ...input } = body;
  const parent = input.parent_version ?? input.base_version;
  const fingerprint = { ...input, parent_version: parent,
    ...(operation === "save" ? { source: input.source ?? "draft_edit" } : {}) };
  return commitChapterWrite(pool, actor, chapter, operation, request_id, fingerprint, async (client) => {
    const current = await readWriteBase(client, chapter.id);
    if (!current) {
      throw new AppError(400, "validation_failed", "Request validation failed", {
        errors: [{ path: "/base_version", message: "save a chapter version first" }],
      });
    }
    const versionChanged = input.base_version !== current.id;
    const foreignParent = input.parent_version !== undefined && parent !== current.id &&
      !await chapterHasVersion(client, chapter.id, parent);
    if (foreignParent && !versionChanged) throw invalidParentVersion();

    const reason = versionChanged || (operation !== "keep_mine" && parent !== current.id) ? "version"
      : input.base_revision !== current.revision ? "revision" : null;
    if (reason) {
      throw new AppError(409, "conflict", "Draft is out of date", {
        reason, current_version: current.id, current_revision: current.revision,
      });
    }
    // Keep the competing text under its own parent before the chosen version
    // clears the head. An existing byte-exact immutable copy needs no new cut.
    let checkpointVersionId: string | null = null;
    if (operation === "keep_mine" && current.head_content !== null &&
        current.head_content !== current.content && current.head_content !== input.content) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM chapter_versions
         WHERE chapter_id = $1 AND convert_to(content, 'UTF8') = convert_to($2, 'UTF8') LIMIT 1`,
        [chapter.id, current.head_content],
      );
      if (!rowCount) {
        const { ids: [id] } = await commitChapterRow(
          client, actor, chapter, "chapter.keep_mine.checkpoint", {
            kind: "chapter_version", chapter_id: chapter.id, content: current.head_content,
            source: "checkpoint", parent_version: current.id, activate: false,
          },
        );
        if (!id) throw new Error("Keep mine checkpoint returned no version ID");
        await insertCheckpointLabel(client, chapter, id, "keep_mine");
        checkpointVersionId = id;
      }
    }
    const active = await readActiveVersionId(client, chapter.id);
    const source = operation === "send" ? (active === null ? "send" : "reupload") : input.source ?? "draft_edit";
    const versionId = await writeVersion(client, actor, chapter, { ...input, parent_version: parent }, source);
    return { version_id: versionId, active_version_id: operation === "send" ? versionId : active,
      checkpoint_version_id: checkpointVersionId };
  });
}
