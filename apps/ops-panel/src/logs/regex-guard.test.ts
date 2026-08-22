import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearRegexGuardCache,
  compileGuardedRegExp,
  findNestedQuantifier,
  MAX_PATTERN_LENGTH,
  probeRegexCost,
} from "./regex-guard.ts";

/** A clock that reports exactly the elapsed times a test wants to describe. */
function scriptedClock(readings: readonly number[]): () => number {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)] ?? 0;
}

test("an ordinary pattern compiles and carries the case flag", () => {
  clearRegexGuardCache();
  const sensitive = compileGuardedRegExp("Quarantine", { caseSensitive: true });
  assert.equal(sensitive.ok, true);
  assert.ok(sensitive.ok && !sensitive.expression.flags.includes("i"));

  const insensitive = compileGuardedRegExp("Quarantine");
  assert.ok(insensitive.ok && insensitive.expression.flags.includes("i"));
});

test("a pattern longer than the bound is refused before it is compiled", () => {
  clearRegexGuardCache();
  const outcome = compileGuardedRegExp("a".repeat(MAX_PATTERN_LENGTH + 1));
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.message.includes(String(MAX_PATTERN_LENGTH)));
});

test("an invalid pattern is reported, not thrown", () => {
  clearRegexGuardCache();
  const outcome = compileGuardedRegExp("import(");
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.message.startsWith("Not a valid pattern"));
});

test("the structural guard names the nested quantifier it found", () => {
  assert.equal(findNestedQuantifier("(a+)+"), "(a+)+");
  assert.equal(findNestedQuantifier("^(\\w*)*$"), "(\\w*)*");
  assert.equal(findNestedQuantifier("(x|x)*"), "(x|x)*");
  assert.equal(findNestedQuantifier("(ab){2,}"), null, "a bounded body is fine");
  assert.equal(findNestedQuantifier("(abc)+"), null);
  assert.equal(findNestedQuantifier("[a+]+"), null, "quantifiers inside a class are literal");
  assert.equal(findNestedQuantifier("\\(a+\\)+"), null, "escaped parentheses are text");
});

test("a catastrophic pattern is refused with an explanation", () => {
  clearRegexGuardCache();
  const outcome = compileGuardedRegExp("(a+)+b");
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.message.includes("repeats a group that already repeats"));
});

test("the measured guard rejects what the structural one cannot see", () => {
  clearRegexGuardCache();
  // Overlapping alternation branches of different lengths: structurally
  // innocent, exponentially slow.
  const outcome = compileGuardedRegExp("(?:a|[a])*c");
  assert.equal(findNestedQuantifier("(?:a|[a])*c"), null, "the structural guard misses it");
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.message.includes("too long"));
});

test("the probe walks a ladder and stops as soon as the budget is gone", () => {
  const cheap = probeRegexCost(/quarantine/giu, {
    probeLengths: [4, 8],
    now: scriptedClock([0, 1, 2]),
  });
  assert.deepEqual(cheap, { withinBudget: true, elapsedMs: 2, probeLength: 8 });

  const expensive = probeRegexCost(/quarantine/giu, {
    probeLengths: [4, 8, 16],
    now: scriptedClock([0, 1, 99]),
  });
  assert.equal(expensive.withinBudget, false);
  assert.equal(expensive.probeLength, 8, "it stops at the rung that blew the budget");
});

test("probing does not disturb the expression it measures", () => {
  const expression = /a/giu;
  expression.lastIndex = 3;
  probeRegexCost(expression, { probeLengths: [4], now: scriptedClock([0, 0]) });
  assert.equal(expression.lastIndex, 3);
});

test("a refusal is remembered so repeated keystrokes do not re-probe", () => {
  clearRegexGuardCache();
  const first = compileGuardedRegExp("(?:a|[a])*c");
  const second = compileGuardedRegExp("(?:a|[a])*c");
  assert.equal(first.ok, false);
  assert.equal(second, first, "the same outcome object comes back");
});
