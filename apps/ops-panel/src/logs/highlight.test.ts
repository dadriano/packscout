import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnsi } from "./ansi.ts";
import { applyHighlights, mergeHighlightRanges } from "./highlight.ts";

const ESC = String.fromCharCode(27);
const sgr = (parameters: string) => `${ESC}[${parameters}m`;

test("overlapping matches merge into one continuous highlight", () => {
  assert.deepEqual(
    mergeHighlightRanges([
      { start: 5, end: 9 },
      { start: 0, end: 4 },
      { start: 3, end: 6 },
    ]),
    [{ start: 0, end: 9 }],
  );
  assert.deepEqual(
    mergeHighlightRanges([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]),
    [
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ],
  );
  assert.deepEqual(mergeHighlightRanges([{ start: 3, end: 3 }]), []);
});

test("plain text splits at the highlight boundaries and nowhere else", () => {
  const spans = parseAnsi("import quarantine failed").spans;
  const highlighted = applyHighlights(spans, [{ start: 7, end: 17 }]);
  assert.deepEqual(
    highlighted.map((span) => [span.text, span.highlighted]),
    [
      ["import ", false],
      ["quarantine", true],
      [" failed", false],
    ],
  );
});

test("a match straddling a colour change is split, keeping both colours", () => {
  const parsed = parseAnsi(`${sgr("31")}quar${sgr("0")}antine done`);
  assert.equal(parsed.plainText, "quarantine done");
  const highlighted = applyHighlights(parsed.spans, [{ start: 0, end: 10 }]);
  assert.deepEqual(
    highlighted.map((span) => [
      span.text,
      span.highlighted,
      span.style.foreground ?? null,
    ]),
    [
      ["quar", true, "var(--panel-ansi-red)"],
      ["antine", true, null],
      [" done", false, null],
    ],
  );
});

test("highlighting never adds, drops, or reorders a character", () => {
  const parsed = parseAnsi(`${sgr("1;33")}warn${sgr("0")}: retrying import 3 of 4`);
  const highlighted = applyHighlights(parsed.spans, [
    { start: 0, end: 4 },
    { start: 15, end: 21 },
  ]);
  assert.equal(highlighted.map((span) => span.text).join(""), parsed.plainText);
  assert.deepEqual(
    highlighted.filter((span) => span.highlighted).map((span) => span.text),
    ["warn", "import"],
  );
});

test("with no ranges the spans come back untouched", () => {
  const spans = parseAnsi(`${sgr("32")}ready${sgr("0")} in 812ms`).spans;
  const highlighted = applyHighlights(spans, []);
  assert.equal(highlighted.length, spans.length);
  assert.ok(highlighted.every((span) => !span.highlighted));
});
