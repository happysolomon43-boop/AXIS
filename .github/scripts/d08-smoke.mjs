import assert from "node:assert/strict";
import { request, withPreview } from "./preview-smoke.mjs";

await withPreview(async () => {
  const tree = await request(1, "POST", "/series", 201, { title: "Ashfall" });
  const bookId = tree.books[0]?.id;
  assert.ok(bookId, "Step 1 first Book ID");

  const first = await request(2, "POST", `/books/${bookId}/chapters`, 201, { content: "# Title\n\nOne" });
  assert.ok(first.chapter?.id && first.version?.id, "Step 2 chapter and version IDs");
  const v1 = first.version.id;
  const path = `/chapters/${first.chapter.id}`;
  const versions = `${path}/versions`;
  const history = `${path}/history`;

  const second = await request(3, "POST", versions, 201, {
    content: "# Title\n\nOne\n\n---\n\nTwo", parent_version: v1,
  });
  const v2 = second.version?.id;
  assert.ok(v2, "Step 3 second version ID");
  assert.equal(second.version.version_no, 2, "Step 3 version number");

  const third = await request(4, "POST", `${path}/send`, 201, {
    content: "# Title\n\nOne\n\n---\n\nTwo!", parent_version: v2,
  });
  const v3 = third.version?.id;
  assert.ok(v3, "Step 4 third version ID");
  assert.equal(third.active_version_id, v3, "Step 4 active version ID");

  const expected = [[v3, "send", 3], [v2, "draft_edit", 3], [v1, "draft_edit", 2]];
  const list = await request(5, "GET", history, 200);
  assert.equal(list.active_version_id, v3, "Step 5 active version ID");
  const historyRows = (rows) => rows.map(({ id, source, word_count }) => [id, source, word_count]);
  assert.deepEqual(historyRows(list.versions), expected, "Step 5 version order, sources, and word counts");

  const firstBlocks = [
    { ordinal: 1, kind: "heading", text: "Title" }, { ordinal: 2, kind: "paragraph", text: "One" },
  ];
  const secondBlocks = [
    ...firstBlocks, { ordinal: 3, kind: "scene_break", text: "---" }, { ordinal: 4, kind: "paragraph", text: "Two" },
  ];
  const older = await request(6, "GET", `${versions}/${v2}`, 200);
  assert.equal(older.version.id, v2, "Step 6 selected version ID");
  assert.deepEqual(older.blocks, secondBlocks, "Step 6 second version's stored blocks");
  const oldest = await request(7, "GET", `${versions}/${v1}`, 200);
  assert.equal(oldest.version.id, v1, "Step 7 selected version ID");
  assert.deepEqual(oldest.blocks, firstBlocks, "Step 7 first version's stored blocks");

  const missingPath = `${versions}/ver_000000000000`;
  const missing = await request(8, "GET", missingPath, 404);
  assert.deepEqual(missing.error, { code: "not_found", message: "Version not found", details: null }, "Step 8 unknown version");
  const hidden = await request(8, "GET", missingPath, 404, undefined, "usr_bob");
  assert.deepEqual(hidden.error, { code: "not_found", message: "Chapter not found", details: null }, "Step 8 non-owner");

  const draft = await request(9, "PUT", `${path}/draft`, 200, {
    content: "# Title\n\nOne\n\n---\n\nTwo!!", base_version: v3, base_revision: 0,
  });
  assert.equal(draft.revision, 1, "Step 9 draft revision");
  const sent = await request(9, "GET", `${versions}/${v3}`, 200);
  assert.deepEqual(sent.blocks, [
    ...secondBlocks.slice(0, 3), { ordinal: 4, kind: "paragraph", text: "Two!" },
  ], "Step 9 saved version ignores the draft head");
  const after = await request(9, "GET", history, 200);
  assert.deepEqual(historyRows(after.versions), expected, "Step 9 draft adds no history row");
  assert.equal(after.active_version_id, v3, "Step 9 active version ID");
});

console.log("D08 live smoke passed");
