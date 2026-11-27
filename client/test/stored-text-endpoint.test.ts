import { expect, test } from "vitest";
import { getStoredText } from "../src/api/endpoints";
import { chapter, ok, rawV1, text, textPath, v1, v2, v3 } from "./d20Fixtures";
import { mockApi } from "./helpers";

test("AC1 reads exact raw and empty sources, with one bodyless authenticated GET each", async () => {
  const ids = ["a/b?#", "v%2F🤍"];
  const encoded = "/api/chapters/a%2Fb%3F%23/versions/v%252F%F0%9F%A4%8D/text";
  const { calls } = mockApi([
    { method: "GET", path: textPath(v1), reply: ok(text(v1)) },
    { method: "GET", path: textPath(v3), reply: ok(text(v3)) },
    { method: "GET", path: encoded, reply: ok({ chapter_id: ids[0], version_id: ids[1], content: rawV1 }) },
  ]);
  await expect(getStoredText(chapter.id, v1)).resolves.toEqual(text(v1, rawV1));
  await expect(getStoredText(chapter.id, v3)).resolves.toEqual(text(v3, ""));
  await expect(getStoredText(ids[0], ids[1])).resolves.toMatchObject({ content: rawV1 });
  expect(calls.map(({ method, path, body }) => [method, path, body])).toEqual([
    ["GET", textPath(v1), undefined], ["GET", textPath(v3), undefined], ["GET", encoded, undefined],
  ]);
  for (const call of calls) expect(call.headers.get("X-Axis-User")).toMatch(/^usr_[a-z0-9]{2,32}$/);
});

test("AC2 rejects malformed coordinates, keys, statuses and scalar values before admitting a body", async () => {
  const million = "🌒".repeat(1_000_000);
  const bad = [text(v2), { ...text(v1), chapter_id: "foreign" }, { ...text(v1), extra: true }, null,
    { ...text(v1), content: null }, text(v1, "x\u0000"), text(v1, "\ud800"), text(v1, "\udc00"),
    text(v1, million + "a")];
  const { calls } = mockApi([{ method: "GET", path: textPath(v1), reply: (_call, n) =>
    n < bad.length ? ok(bad[n]) : n === bad.length ? { status: 201, body: text(v1) } : ok(text(v1, million)) }]);
  for (const _ of bad) await expect(getStoredText(chapter.id, v1)).rejects.toMatchObject({
    name: "ApiError", status: 200, code: "unreadable", details: null,
  });
  await expect(getStoredText(chapter.id, v1)).rejects.toMatchObject({ status: 201, code: "unreadable", details: null });
  await expect(getStoredText(chapter.id, v1)).resolves.toEqual(text(v1, million));
  expect(calls).toHaveLength(bad.length + 2);
});

test.each([[401, "auth_required"], [404, "not_found"], [500, "internal"], [0, "network"]] as const)(
  "AC3 propagates %i %s without retry", async (status, code) => {
    const { calls } = mockApi([{ method: "GET", path: textPath(v1), reply: status === 0 ? "network"
      : { status, body: { error: { code, message: "Service failure", details: null } } } }]);
    await expect(getStoredText(chapter.id, v1)).rejects.toMatchObject({ name: "ApiError", status, code, details: null });
    expect(calls).toHaveLength(1);
  },
);
