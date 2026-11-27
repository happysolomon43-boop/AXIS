import assert from "node:assert/strict";
import { request, withPreview, writeGuard } from "./preview-smoke.mjs";

await withPreview(async () => {
  const series = await request(1, "POST", "/series", 201, { title: "Ashfall" });
  assert.ok(series.books[0]?.id, "Step 1 first Book ID");
  const first = await request(2, "POST", `/books/${series.books[0].id}/chapters`, 201, { content: "# Title\n\nHello" });
  assert.ok(first.chapter?.id && first.version?.id, "Step 2 chapter and version IDs");
  const path = `/chapters/${first.chapter.id}`;
  const draftPath = `${path}/draft`;
  const v1 = first.version.id;
  const input = { content: "# Title\n\nHello!", base_version: v1, base_revision: 0 };

  assert.equal((await request(3, "GET", draftPath, 200)).draft, null, "Step 3 no head");
  assert.equal((await request(4, "PUT", draftPath, 200, input)).revision, 1, "Step 4 first revision");
  assert.deepEqual((await request(5, "GET", draftPath, 200)).draft, {
    base_version: v1, revision: 1, content: input.content,
    blocks: [{ ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "Hello!" }],
  }, "Step 5 head payload");
  const duplicate = await request(6, "PUT", draftPath, 409, input);
  assert.deepEqual(duplicate.error, {
    code: "conflict", message: "Draft is out of date",
    details: { reason: "revision", current_version: v1, current_revision: 1 },
  }, "Step 6 revision conflict");
  const saved = await request(7, "POST", `${path}/versions`, 201, { content: input.content, parent_version: v1, ...writeGuard(v1, 1) });
  assert.equal(saved.version?.version_no, 2, "Step 7 version number");
  assert.equal((await request(8, "GET", draftPath, 200)).draft, null, "Step 8 cleared head");
  const stale = await request(9, "PUT", draftPath, 409, input);
  assert.deepEqual(stale.error, {
    code: "conflict", message: "Draft is out of date",
    details: { reason: "version", current_version: saved.version.id, current_revision: 0 },
  }, "Step 9 version conflict");
});
console.log("D07 live smoke passed");
