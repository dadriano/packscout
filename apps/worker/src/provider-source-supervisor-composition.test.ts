import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProviderSourceControlPlaneFailure } from
  "./provider-source-supervisor-composition.ts";

test("database timeout codes classify as retryable timeouts", () => {
  assert.equal(
    classifyProviderSourceControlPlaneFailure({ code: "P2024" }),
    "timeout",
  );
  // P2028 is Prisma's interactive-transaction invalidation (the $transaction
  // callback outlived or lost its transaction); the replay is idempotent, so
  // it must retry instead of fencing the runtime as an invariant.
  assert.equal(
    classifyProviderSourceControlPlaneFailure({ code: "P2028" }),
    "timeout",
  );
  assert.equal(
    classifyProviderSourceControlPlaneFailure({ code: "57014" }),
    "timeout",
  );
});

test("unrecognized failures stay non-retryable invariants", () => {
  assert.equal(
    classifyProviderSourceControlPlaneFailure({ code: "P2002" }),
    "invariant",
  );
  assert.equal(
    classifyProviderSourceControlPlaneFailure(new Error("boom")),
    "invariant",
  );
});
