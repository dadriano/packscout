import assert from "node:assert/strict";
import { test } from "node:test";
import { ConvexError } from "convex/values";
import { tolerantQueryOutcome } from "./tolerant-query.client";

test("a value is data and a missing result is simply not there yet", () => {
  assert.deepEqual(tolerantQueryOutcome({ admitted: false }), {
    data: { admitted: false },
    error: undefined,
  });
  assert.deepEqual(tolerantQueryOutcome(undefined), {
    data: undefined,
    error: undefined,
  });
});

test("a refusal is a value the caller reads, never something that throws", () => {
  const refusal = new ConvexError({ code: "BETA_ACCESS_AWAITING_REVIEW" });
  const outcome = tolerantQueryOutcome(refusal);
  assert.equal(outcome.data, undefined);
  assert.equal(outcome.error, refusal);
});

test("plain transport errors partition the same way", () => {
  const failure = new Error("connection lost");
  assert.deepEqual(tolerantQueryOutcome(failure), {
    data: undefined,
    error: failure,
  });
});
