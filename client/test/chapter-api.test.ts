import { expect, test } from "vitest";
import { getChapter, writeChapter } from "../src/api/endpoints";
import { a, b, c, chapterA, chapterPath, detailText, reply, writtenC } from "./d06.fixtures";
import { mockApi } from "./helpers";
import { writeResponse } from "./writeFixtures";

test("sends guarded Save and Send once, and encodes path parameters", async () => {
  const body = { content: "Hello", parent_version: b, base_version: b, base_revision: 2,
    request_id: "11111111-1111-4111-8111-111111111111" };
  const { calls } = mockApi([
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    { method: "GET", path: "/api/chapters/a%2Fb", reply: reply(detailText) },
    { method: "GET", path: "/api/chapters/missing", reply: reply({ error: { code: "not_found", message: "Chapter not found" } }, 404) },
    { method: "POST", path: chapterPath + "/versions", reply: call => writeResponse(call, reply(writtenC(null), 201)) },
    { method: "POST", path: chapterPath + "/send", reply: call => writeResponse(call, reply(writtenC(c), 201)) },
    { method: "POST", path: "/api/chapters/a%2Fb/versions", reply: { status: 400, body: { error: { code: "validation_failed", message: "Invalid" } } } },
  ]);
  expect(await getChapter(chapterA.id)).toEqual(detailText);
  expect(await getChapter("a/b")).toEqual(detailText);
  await expect(writeChapter(chapterA.id, chapterA.book_id, "save", body)).resolves.toMatchObject({ active_version_id: null, request_id: body.request_id });
  await expect(writeChapter(chapterA.id, chapterA.book_id, "send", body)).resolves.toMatchObject({ active_version_id: c, request_id: body.request_id });
  await expect(writeChapter("a/b", chapterA.book_id, "save", { ...body, parent_version: a })).rejects.toMatchObject({ code: "validation_failed" });
  await expect(getChapter("missing")).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(calls.filter(call => call.method === "POST").map(call => call.body)).toEqual([body, body, { ...body, parent_version: a }]);
});
