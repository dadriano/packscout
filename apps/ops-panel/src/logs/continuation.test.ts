import assert from "node:assert/strict";
import { test } from "node:test";
import { isContinuationText } from "./continuation.ts";

test("indented output continues the line above it", () => {
  assert.equal(isContinuationText("    at run (/app/worker.ts:14:9)"), true);
  assert.equal(isContinuationText("\tat Object.<anonymous> (/app/x.ts:1:1)"), true);
  assert.equal(isContinuationText("  { detail: 'quarantined' }"), true);
});

test("the named forms that sit flush left are recognised too", () => {
  assert.equal(isContinuationText("Caused by: java.io.IOException: broken pipe"), true);
  assert.equal(isContinuationText("... 12 more"), true);
  assert.equal(isContinuationText("Suppressed: another failure"), true);
  assert.equal(isContinuationText('File "run.py", line 42, in main'), true);
  assert.equal(isContinuationText("        ^^^^"), true);
});

test("a line that stands on its own is not folded away", () => {
  assert.equal(isContinuationText("ERROR import failed"), false);
  assert.equal(isContinuationText("Traceback (most recent call last):"), false);
  assert.equal(isContinuationText("at least three providers are stale"), false);
  assert.equal(isContinuationText(""), false);
  assert.equal(isContinuationText("   "), false);
  assert.equal(isContinuationText(" single space prose"), false);
});
