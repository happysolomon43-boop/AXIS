import { afterAll, expect, test } from "vitest";
import { makePool } from "./helpers.js";
import { abcHash, expectReapplyAll, rollbackAll, story, storyBlocks } from "./seed.js";

const pool = makePool();
const signatures = ["axis_fold(text)", "axis_normalize(text)", "axis_sentences(text)", "axis_segment(text)"];
const whitespace = [
  9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195,
  8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288,
].map((point) => String.fromCodePoint(point));

async function fold(input: string) {
  return (await pool.query("SELECT axis_fold($1) AS value", [input])).rows[0].value;
}

async function normalize(input: string) {
  return (await pool.query("SELECT axis_normalize($1) AS value", [input])).rows[0].value;
}

async function segment(input: string) {
  return (await pool.query("SELECT axis_segment($1) AS value", [input])).rows[0].value;
}

function paragraph(ordinal: number, text: string, scene = 1) {
  return { ordinal, kind: "paragraph", text, scene };
}

function heading(ordinal: number, text: string) {
  return { ordinal, kind: "heading", text, scene: 1 };
}

function sceneBreak(ordinal: number, text = "---") {
  return { ordinal, kind: "scene_break", text, scene: null };
}

afterAll(async () => {
  await pool.end();
});

test("AC1 folds exactly W and normalizes only the specified typographic characters", async () => {
  expect(await fold("abc")).toBe("abc");
  expect(await fold("  a \t b\n\nc  ")).toBe("a b c");
  for (const char of whitespace) expect(await fold("a" + char + "b")).toBe("a b");
  expect(await fold("a" + whitespace.join("") + "b")).toBe("a b");
  expect(await fold(whitespace.join(""))).toBe("");
  expect(await fold("")).toBe("");
  expect(await fold("a\u200bb\ufeffc")).toBe("a\u200bb\ufeffc");
  expect((await pool.query(
    "SELECT encode(sha256(convert_to(axis_fold('abc'), 'UTF8')), 'hex') AS hash",
  )).rows).toEqual([{ hash: abcHash }]);

  expect(await normalize("“Hi,” she said — ‘ok’.")).toBe(`"Hi," she said - 'ok'.`);
  expect(await normalize("a–b−c")).toBe("a-b-c");
  expect(await normalize("Wait…")).toBe("Wait…");
});

test("AC2 splits only at the specified sentence boundaries", async () => {
  const cases: Array<[string, string[]]> = [
    ["He left. She stayed.", ["He left.", "She stayed."]],
    ['He said "no." Then he left.', ['He said "no."', "Then he left."]],
    ['"Go," she said. "Now."', ['"Go," she said.', '"Now."']],
    ["Wait... what?", ["Wait... what?"]],
    ["Wait... What?", ["Wait...", "What?"]],
    ["Wait… What?", ["Wait…", "What?"]],
    ["Is it? yes.", ["Is it? yes."]],
    ["3.5 apples. 4 pears.", ["3.5 apples.", "4 pears."]],
    ["(He left.) Then.", ["(He left.)", "Then."]],
    ["[He left.] Then.", ["[He left.]", "Then."]],
    ["Mr. Hale left.", ["Mr.", "Hale left."]],
    ["  a  b \n c.  ", ["a b c."]],
    ["", []],
    ["   ", []],
  ];
  for (const [input, expected] of cases) {
    expect((await pool.query("SELECT axis_sentences($1) AS value", [input])).rows)
      .toEqual([{ value: expected }]);
  }
});

test("AC3 segments paragraphs, headings, breaks, and dense scenes", async () => {
  const cases: Array<[string, unknown[]]> = [
    [story, storyBlocks],
    ["---\n\nA\n\n---\n---\n\nB\n\n***", [
      sceneBreak(1), paragraph(2, "A"), sceneBreak(3), sceneBreak(4), paragraph(5, "B", 2), sceneBreak(6, "***"),
    ]],
    ["A\n\n---\n\nB\n\n---\n\nC", [
      paragraph(1, "A"), sceneBreak(2), paragraph(3, "B", 2), sceneBreak(4), paragraph(5, "C", 3),
    ]],
    ["", []],
    ["\n \n", []],
    ["Line one\nline two\n\nNext", [paragraph(1, "Line one\nline two"), paragraph(2, "Next")]],
    ["a\r\n\r\nb", [paragraph(1, "a"), paragraph(2, "b")]],
    ["a\rb", [paragraph(1, "a\nb")]],
    ["#hashtag", [paragraph(1, "#hashtag")]],
    ["####### seven", [paragraph(1, "####### seven")]],
    ["#", [paragraph(1, "#")]],
    ["###### six", [heading(1, "six")]],
    ["#  spaced  title  ", [heading(1, "spaced  title")]],
    ["text\n# H\nmore", [paragraph(1, "text"), heading(2, "H"), paragraph(3, "more")]],
    ["---x", [paragraph(1, "---x")]],
    ["---\n***", [sceneBreak(1), sceneBreak(2, "***")]],
  ];
  for (const [input, expected] of cases) expect(await segment(input)).toEqual(expected);
});

test("AC4 verifies immutable, strict, deterministic functions and rollback", async () => {
  const { rows: flags } = await pool.query(
    `SELECT p.provolatile, p.proisstrict
     FROM unnest($1::text[]) AS signature(name)
     JOIN pg_proc AS p ON p.oid = to_regprocedure(signature.name)`,
    [signatures],
  );
  expect(flags).toEqual(signatures.map(() => ({ provolatile: "i", proisstrict: true })));
  const sql = `SELECT axis_fold($1) AS folded, axis_normalize($1) AS normalized,
                      axis_sentences($1) AS sentences, axis_segment($1) AS segmented`;
  expect((await pool.query(sql, [null])).rows).toEqual([
    { folded: null, normalized: null, sentences: null, segmented: null },
  ]);
  const initial = (await pool.query(sql, [story])).rows;
  expect((await pool.query(sql, [story])).rows).toEqual(initial);

  const functions = async () => (await pool.query(
    "SELECT to_regprocedure(name)::text AS existing FROM unnest($1::text[]) AS signature(name)",
    [signatures],
  )).rows;
  await rollbackAll(pool);
  expect(await functions()).toEqual(signatures.map(() => ({ existing: null })));
  await expectReapplyAll(pool);
  expect(await functions()).toEqual(signatures.map((name) => ({ existing: name })));
});
