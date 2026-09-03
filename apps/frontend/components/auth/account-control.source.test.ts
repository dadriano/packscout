import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Wiring proof for the shell's account menu. What sign-out decides is proven
 * behaviorally in sign-out-handoff.test.ts; these assertions pin how the
 * component composes it — the ordering that makes the hand-off safe, and the
 * places the exit must not be.
 */
const accountSource = readFileSync(
  new URL("./AccountControl.client.tsx", import.meta.url),
  "utf8",
);

test("signing out from the shell leaves through the shared performer", () => {
  // Access is resolved server-side per request. Without this exit the person
  // keeps reading a server-rendered catalog they are no longer admitted to,
  // until they happen to click something.
  assert.match(
    accountSource,
    /runSignOutFollowUp\(signOutFollowUp\(settled\), browserSignOutEffects\(auth\.login\)\)/,
  );
});

test("the exit is a document replacement, so this component holds no router", () => {
  // A client-router navigation keeps the document and the router's
  // per-document segment cache with it, and a back/forward traversal reads
  // that cache with staleness checks bypassed — one Back press restores the
  // admitted catalog this tab already rendered, gate and all skipped. The
  // component must not hold a router it could reintroduce that with.
  assert.equal(accountSource.includes("useRouter"), false);
  assert.equal(accountSource.includes("next/navigation"), false);
  assert.equal(accountSource.includes("router.replace"), false);
  assert.equal(accountSource.includes("router.push"), false);
  assert.equal(accountSource.includes("router.refresh"), false);
  // And the replacement itself is spelled once, in the shared module.
  assert.equal(accountSource.includes("window.location"), false);
  assert.match(accountSource, /browserSignOutEffects/);
});

test("the session ends before the exit that depends on it", () => {
  // The context's logout clears the server-readable identity cookie as part
  // of that call, so the awaited ordering is what makes the request the exit
  // sends read as signed out.
  const logoutAt = accountSource.indexOf("await auth.logout();");
  const followUpAt = accountSource.indexOf("runSignOutFollowUp(");
  assert.ok(logoutAt !== -1);
  assert.ok(followUpAt > logoutAt);
  assert.equal(accountSource.match(/runSignOutFollowUp\(/g)?.length, 1);
});

test("a failed sign-out settles as failed and still reaches the follow-up", () => {
  // The credential is cleared in a `finally`, so a failed provider call has
  // still signed this person out server-side. Returning early from the catch
  // left them on a fully rendered admitted page; the follow-up decides what
  // a failure does, and it is reached from both branches.
  assert.match(
    accountSource,
    /\} catch \{[\s\S]*?settled = \{ type: "failed", next: "landing" \};\s*\}/,
  );
  const catchAt = accountSource.indexOf("} catch {");
  const followUpAt = accountSource.indexOf("runSignOutFollowUp(");
  assert.ok(catchAt !== -1);
  assert.ok(followUpAt > catchAt);
  // No early return can skip the exit.
  assert.equal(
    /\} catch \{[\s\S]*?\breturn;[\s\S]*?\}/.test(
      accountSource.slice(catchAt, followUpAt),
    ),
    false,
  );
});

test("the hand-off lives in the handler, never in a session-status effect", () => {
  // An effect watching auth.status would also fire during the holding
  // surface's switch-identity flow, which signs out and signs back in from
  // that page, and would drag that visitor to the landing root mid-switch.
  const signOutAt = accountSource.indexOf("async function signOut()");
  assert.notEqual(signOutAt, -1);
  assert.ok(accountSource.lastIndexOf("useEffect(") < signOutAt);
  assert.ok(accountSource.indexOf("runSignOutFollowUp(") > signOutAt);
});

test("the control's label, disabled state, and message come from the shared machine", () => {
  assert.match(accountSource, /presentSignOutControl\(logoutState\)/);
  assert.match(accountSource, /disabled=\{signOutControl\.disabled\}/);
  assert.match(accountSource, /\{signOutControl\.label\}/);
  assert.match(accountSource, /\{signOutControl\.status\}/);
  assert.match(accountSource, /signOutRequestAccepted\(logoutState\)/);
  // No second copy of the sentences the holding surface already owns.
  assert.equal(accountSource.includes("Sign out failed."), false);
  assert.equal(accountSource.includes("Signing out…"), false);
});
