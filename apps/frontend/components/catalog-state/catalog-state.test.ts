import assert from "node:assert/strict";
import { test } from "node:test";
import { publicReadError } from "@packscout/contracts";
import {
  CATALOG_STATE_COPY,
  catalogResultRecoveryPresentation,
  catalogUpdateMessage,
  recoveryMessage,
  reduceRecoverableActionState,
  usableConstraints,
} from "./catalog-state";

test("uses the approved public catalog-state vocabulary without operational detail", () => {
  assert.deepEqual(
    {
      loading: CATALOG_STATE_COPY.loading,
      unavailable: CATALOG_STATE_COPY.unavailable,
      empty: CATALOG_STATE_COPY.empty,
      noMatches: CATALOG_STATE_COPY.noMatches,
      retry: CATALOG_STATE_COPY.retry,
      clearFilters: CATALOG_STATE_COPY.clearFilters,
      retainedFailure: CATALOG_STATE_COPY.retainedFailure,
    },
    {
      loading: "Loading repack data.",
      unavailable: "Repack data is temporarily unavailable.",
      empty: "Repack data is not available yet.",
      noMatches: "No repacks match these filters.",
      retry: "Retry",
      clearFilters: "Clear filters",
      retainedFailure: "Could not refresh. Showing your previous results.",
    },
  );
  assert.doesNotMatch(
    JSON.stringify(CATALOG_STATE_COPY),
    /tenant|quarantine|run id|stack|provider failure|internal code/i,
  );
});

test("keeps a recoverable command pending until one terminal outcome", () => {
  assert.equal(reduceRecoverableActionState("idle", "start"), "pending");
  assert.equal(reduceRecoverableActionState("pending", "start"), "pending");
  assert.equal(reduceRecoverableActionState("pending", "succeed"), "succeeded");
  assert.equal(reduceRecoverableActionState("pending", "fail"), "failed");
  assert.equal(reduceRecoverableActionState("failed", "succeed"), "failed");
  assert.equal(
    recoveryMessage("pending", {
      pending: "Working",
      succeeded: "Done",
      failed: "Failed",
    }),
    "Working",
  );
});

test("announces updating, retained failure, and bounded result counts", () => {
  assert.equal(catalogUpdateMessage({ state: "idle" }), "");
  assert.equal(
    catalogUpdateMessage({ state: "updating" }),
    "Updating results…",
  );
  assert.equal(
    catalogUpdateMessage({ state: "failed" }),
    "Could not refresh. Showing your previous results.",
  );
  assert.equal(
    catalogUpdateMessage({ state: "updated", visibleCount: 1 }),
    "1 repack shown.",
  );
  assert.equal(
    catalogUpdateMessage({ state: "updated", visibleCount: 25 }),
    "25 repacks shown.",
  );
});

test("summarizes only visible non-blank catalog constraints", () => {
  assert.deepEqual(
    usableConstraints([
      { label: " Search ", value: "  Mythic  " },
      { label: "Platform", value: "Collector Crypt" },
      { label: "", value: "hidden" },
      { label: "Category", value: "   " },
    ]),
    [
      { label: "Search", value: "Mythic" },
      { label: "Platform", value: "Collector Crypt" },
    ],
  );
});

test("only release unavailability retries; stable query errors navigate to recovery", () => {
  assert.deepEqual(
    catalogResultRecoveryPresentation(publicReadError("RELEASE_UNAVAILABLE")),
    { kind: "retry" },
  );

  const expectedActions = {
    INVALID_QUERY: "Reset repack catalog",
    CURSOR_EXPIRED: "Return to first page",
    COLLECTIBLE_NOT_FOUND: "Clear desired chase",
    REPACK_NOT_FOUND: "Clear repack selection",
  } as const;
  for (const [code, actionLabel] of Object.entries(expectedActions)) {
    const recovery = catalogResultRecoveryPresentation(
      publicReadError(code as keyof typeof expectedActions),
    );
    assert.equal(recovery.kind, "navigate", code);
    if (recovery.kind === "navigate") {
      assert.equal(recovery.actionLabel, actionLabel, code);
    }
  }
});
