import { expect, test } from "vitest";
import { getChapter, saveVersion, sendChapter } from "../src/api/endpoints";
import { ApiError } from "../src/api/http";
import { mockApi } from "./helpers";
import { a, chapterA, chapterPath, detailText, reply, writtenC } from "./d06.fixtures";

test("AXB-0037 AC2 uses the exact chapter API methods, encoded ids, bodies and errors", async () => {
  const { calls } = mockApi([
    { method: "GET", path: chapterPath, reply: reply(detailText) },
    { method: "GET", path: "/api/chapters/a%2Fb", reply: reply(detailText) },
    { method: "POST", path: `${chapterPath}/versions`, reply: reply(writtenC(null), 201) },
    { method: "POST", path: `${chapterPath}/send`, reply: reply(writtenC(writtenC(null).version.id), 201) },
    { method: "POST", path: "/api/chapters/a%2Fb/versions", reply: reply(writtenC(null), 201) },
    { method: "POST", path: "/api/chapters/a%2Fb/send", reply: reply(writtenC(null), 201) },
    { method: "GET", path: "/api/chapters/missing", reply: reply({ error: { code: "not_found", message: "Chapter not found", details: null } }, 404) },
  ]);
  expect(await getChapter(chapterA.id)).toEqual(detailText);
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.has("Content-Type")).toBe(false);
  expect(await getChapter("a/b")).toEqual(detailText);
  expect(await saveVersion(chapterA.id, "Hello", a)).toEqual(writtenC(null));
  expect(await sendChapter(chapterA.id, "Hello", a)).toEqual(writtenC(writtenC(null).version.id));
  await saveVersion("a/b", "", a);
  await sendChapter("a/b", "", a);
  const error = await getChapter("missing").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "not_found", status: 404 });
  expect(calls.map(({ method, path, body }) => [method, path, body])).toEqual([
    ["GET", chapterPath, undefined], ["GET", "/api/chapters/a%2Fb", undefined],
    ["POST", `${chapterPath}/versions`, { content: "Hello", parent_version: a }],
    ["POST", `${chapterPath}/send`, { content: "Hello", parent_version: a }],
    ["POST", "/api/chapters/a%2Fb/versions", { content: "", parent_version: a }],
    ["POST", "/api/chapters/a%2Fb/send", { content: "", parent_version: a }],
    ["GET", "/api/chapters/missing", undefined],
  ]);
  expect(JSON.stringify(calls[2].body)).toBe(`{"content":"Hello","parent_version":"${a}"}`);
  expect(JSON.stringify(calls[3].body)).toBe(JSON.stringify(calls[2].body));
});
