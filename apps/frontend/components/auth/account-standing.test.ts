import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PRODUCT_USER_SUSPENDED_ERROR_CODE } from "@packscout/contracts";
import {
  isSuspendedAccountRefusal,
  presentAccountStandingNotice,
  readRefusalCode,
  SUSPENDED_ACCOUNT_NOTICE,
} from "./account-standing";
import { presentSavedItemMutationMessage } from "./saved-item-presentation";

const providerSource = readFileSync(
  new URL("./AuthenticatedSavedItemsProvider.client.tsx", import.meta.url),
  "utf8",
);
const accountControlSource = readFileSync(
  new URL("./AccountControl.client.tsx", import.meta.url),
  "utf8",
);

test("the suspended refusal is recognised, and nothing else is mistaken for it", () => {
  const refusal = {
    data: { code: PRODUCT_USER_SUSPENDED_ERROR_CODE, message: "ignored" },
  };
  assert.equal(readRefusalCode(refusal), "ACCOUNT_SUSPENDED");
  assert.equal(isSuspendedAccountRefusal(refusal), true);

  // Every other failure a write can produce reads as an ordinary failure.
  for (const other of [
    { data: { code: "SAVED_ITEM_LIMIT_REACHED" } },
    { data: { code: "AUTH_REQUIRED" } },
    { data: { code: "SAVED_RESOURCE_UNAVAILABLE" } },
    new Error("network down"),
    { data: null },
    { data: { code: "" } },
    { data: { code: 7 } },
    "ACCOUNT_SUSPENDED",
    null,
    undefined,
  ]) {
    assert.equal(isSuspendedAccountRefusal(other), false);
  }
  assert.equal(readRefusalCode(new Error("network down")), null);
});

test("the account notice appears only for a signed-in suspended account", () => {
  // The standing read at session establishment is enough on its own.
  assert.equal(
    presentAccountStandingNotice({
      signedIn: true,
      standing: "suspended",
      refusedAsSuspended: false,
    }),
    SUSPENDED_ACCOUNT_NOTICE,
  );
  // So is a blocked write, which covers the moment before the read catches up.
  assert.equal(
    presentAccountStandingNotice({
      signedIn: true,
      standing: "unknown",
      refusedAsSuspended: true,
    }),
    SUSPENDED_ACCOUNT_NOTICE,
  );

  // An active or not-yet-known account is told nothing at all.
  for (const standing of ["active", "unknown"] as const) {
    assert.equal(
      presentAccountStandingNotice({
        signedIn: true,
        standing,
        refusedAsSuspended: false,
      }),
      null,
    );
  }

  // A signed-out visitor browses exactly as before; there is no account to
  // report on, whatever any earlier session left behind.
  for (const standing of ["active", "suspended", "unknown"] as const) {
    assert.equal(
      presentAccountStandingNotice({
        signedIn: false,
        standing,
        refusedAsSuspended: true,
      }),
      null,
    );
  }
});

test("a reinstated account stops being told it is suspended", () => {
  // The journey a suspended-then-reinstated person actually takes. The
  // refusal is one blocked write; the standing read is live and keeps
  // answering, so once it reports the account active the refusal is spent
  // evidence and must stop speaking for it.
  const journey = [
    // A save is blocked before the standing read has said anything.
    { standing: "unknown", refusedAsSuspended: true },
    // The read answers and confirms it.
    { standing: "suspended", refusedAsSuspended: true },
    // An operator reinstates the account and the live read reports it. The
    // person is not made to attempt another save to find that out.
    { standing: "active", refusedAsSuspended: true },
  ] as const;
  assert.deepEqual(
    journey.map((step) =>
      presentAccountStandingNotice({ signedIn: true, ...step })
    ),
    [SUSPENDED_ACCOUNT_NOTICE, SUSPENDED_ACCOUNT_NOTICE, null],
  );

  // Suspended again afterwards, the live read still governs and says so.
  assert.equal(
    presentAccountStandingNotice({
      signedIn: true,
      standing: "suspended",
      refusedAsSuspended: false,
    }),
    SUSPENDED_ACCOUNT_NOTICE,
  );
});

test("the notice explains the account without exposing anything operational", () => {
  assert.match(SUSPENDED_ACCOUNT_NOTICE, /account is suspended/);
  // It states what is kept and what still works, so nothing looks lost.
  assert.match(SUSPENDED_ACCOUNT_NOTICE, /Everything you saved is still here/);
  assert.match(SUSPENDED_ACCOUNT_NOTICE, /keep browsing/);
  // It names no operator, code, reason, or backend.
  assert.doesNotMatch(
    SUSPENDED_ACCOUNT_NOTICE,
    /admin|operator|convex|error|code|ACCOUNT_SUSPENDED/i,
  );
});

test("a blocked save reads as a suspended account, not a retryable fault", () => {
  const suspended = presentSavedItemMutationMessage({
    kind: "repack",
    saved: false,
    outcome: "error",
    errorCode: PRODUCT_USER_SUSPENDED_ERROR_CODE,
  });
  assert.deepEqual(suspended, {
    copy: SUSPENDED_ACCOUNT_NOTICE,
    tone: "error",
  });
  // Telling this person to try again would be untrue.
  assert.doesNotMatch(suspended.copy, /Try again/);

  // The same block on the other kind reads identically: it is the account.
  assert.deepEqual(
    presentSavedItemMutationMessage({
      kind: "collectible",
      saved: true,
      outcome: "error",
      errorCode: PRODUCT_USER_SUSPENDED_ERROR_CODE,
    }),
    { copy: SUSPENDED_ACCOUNT_NOTICE, tone: "error" },
  );

  // Any other failure keeps the ordinary retryable message.
  for (const errorCode of [null, undefined, "SAVED_ITEM_LIMIT_REACHED"]) {
    assert.deepEqual(
      presentSavedItemMutationMessage({
        kind: "repack",
        saved: false,
        outcome: "error",
        errorCode,
      }),
      { copy: "We couldn't update this repack. Try again.", tone: "error" },
    );
  }

  // A successful write is unaffected by any of this.
  assert.deepEqual(
    presentSavedItemMutationMessage({
      kind: "repack",
      saved: true,
      outcome: "success",
    }),
    { copy: "Repack saved to your account.", tone: "success" },
  );
});

test("the product learns standing from the authenticated self-standing read", () => {
  // Session establishment reads the account's own standing, skipped entirely
  // while signed out so public browsing makes no authenticated call. The
  // read is tolerant (closed-beta-access/008): a refusal is a value, never a
  // render crash above the provider tree.
  assert.match(
    providerSource,
    /useTolerantQuery\(\s*api\.productUsers\.getMyStanding,\s*signedIn \? \{\} : "skip",\s*\)\.data/,
  );
  // A blocked write is the second arrival of the same fact, and a completed
  // write clears it, so reinstatement needs no reload.
  assert.match(
    providerSource,
    /if \(isSuspendedAccountRefusal\(error\)\) setRefusedAsSuspended\(true\);/,
  );
  assert.match(providerSource, /setRefusedAsSuspended\(false\);/);
  // Only the stable code crosses into presentation; no backend text is shown.
  assert.match(providerSource, /errorCode: readRefusalCode\(error\)/);
  assert.equal(providerSource.includes("error.message"), false);

  // The notice reaches the account surface, and nothing gates public content.
  assert.match(accountControlSource, /useAccountNotice\(\)/);
  assert.match(accountControlSource, /Account suspended/);
});
