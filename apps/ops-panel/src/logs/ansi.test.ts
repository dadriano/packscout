import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnsi, stripAnsi } from "./ansi.ts";

const ESC = String.fromCharCode(27);
const sgr = (parameters: string) => `${ESC}[${parameters}m`;

test("plain text passes through as one unstyled span", () => {
  const result = parseAnsi("nothing special here");
  assert.deepEqual(result.spans, [
    { text: "nothing special here", style: {} },
  ]);
  assert.equal(result.plainText, "nothing special here");
  assert.equal(result.styled, false);
});

test("colour and emphasis become styled spans", () => {
  const result = parseAnsi(`ready ${sgr("1;31")}failed${sgr("0")} again`);
  assert.deepEqual(
    result.spans.map((span) => [span.text, span.style.bold ?? false]),
    [
      ["ready ", false],
      ["failed", true],
      [" again", false],
    ],
  );
  assert.equal(result.spans[1]?.style.foreground, "var(--panel-ansi-red)");
  assert.equal(result.styled, true);
});

test("the plain form is the text with every escape removed", () => {
  const line = `${sgr("32")}ok${sgr("0")} ${sgr("38;5;208")}warn${sgr("39")}`;
  assert.equal(parseAnsi(line).plainText, "ok warn");
  assert.equal(stripAnsi(line), "ok warn");
  assert.equal(
    stripAnsi(line),
    parseAnsi(line).spans.map((span) => span.text).join(""),
    "copy, filter, and render agree on the same characters",
  );
});

test("256-colour and true-colour sequences resolve to concrete colours", () => {
  assert.equal(
    parseAnsi(`${sgr("38;5;196")}x`).spans[0]?.style.foreground,
    "rgb(255 0 0)",
  );
  assert.equal(
    parseAnsi(`${sgr("48;2;10;20;30")}x`).spans[0]?.style.background,
    "rgb(10 20 30)",
  );
  assert.equal(
    parseAnsi(`${sgr("38;5;9")}x`).spans[0]?.style.foreground,
    "var(--panel-ansi-bright-red)",
  );
});

test("a reset clears every attribute, not just colour", () => {
  const result = parseAnsi(`${sgr("1;4;31")}loud${sgr("0")}quiet`);
  assert.deepEqual(result.spans[1]?.style, {});
});

test("a sequence cut off mid-line is shown rather than swallowed", () => {
  // A forced flush can end a line inside an escape sequence.
  const result = parseAnsi(`text ${ESC}[38;5`);
  assert.equal(result.plainText, `text ${ESC}[38;5`);
  assert.equal(result.spans.length, 1);
});

test("an unknown escape does not eat the text after it", () => {
  const result = parseAnsi(`before ${ESC}?weird after`);
  assert.match(result.plainText, /before/u);
  assert.match(result.plainText, /after$/u);
});

test("non-colour control sequences are dropped from the canonical text", () => {
  // Cursor movement and erase-line mean nothing in a scrollback pane.
  const result = parseAnsi(`start${ESC}[2K${ESC}[1Gend`);
  assert.equal(result.plainText, "startend");
});

test("malformed parameter lists never throw", () => {
  for (const line of [
    `${sgr(";;;")}x`,
    `${sgr("999")}x`,
    `${sgr("38;2;1")}x`,
    `${ESC}[`,
    `${ESC}`,
  ]) {
    assert.doesNotThrow(() => parseAnsi(line));
  }
});
