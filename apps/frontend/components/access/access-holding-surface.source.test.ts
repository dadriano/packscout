import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Wiring proof for the holding surface (closed-beta-access/008). The state
 * logic — which notice shows, when the visitor enters the product, what the
 * identity block and controls present — is proven behaviorally in
 * access-holding-presentation.test.ts; these assertions pin how the client
 * component composes it: the one authenticated call, the live navigation,
 * the session controls, and the accessibility contract.
 */

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const surfaceSource = source("./AccessHoldingNotice.client.tsx");
const pageSource = source("../../app/access/page.tsx");

test("the surface's only authenticated call is the effective-access self-read, made tolerantly", () => {
  const apiReferences = surfaceSource.match(/\bapi\.[A-Za-z0-9_.]+/g) ?? [];
  assert.deepEqual(apiReferences, ["api.productUserAccess.getMyAccess"]);
  assert.match(
    surfaceSource,
    /useTolerantQuery\(api\.productUserAccess\.getMyAccess, \{\}\)/,
  );
  // No catalog read, no mutation, no capability: the surface renders whole
  // while the catalog read model is closed.
  assert.equal(surfaceSource.includes("useMutation"), false);
  assert.equal(surfaceSource.includes("fetch("), false);
  assert.equal(/public-repacks|collectibles|savedItems/.test(surfaceSource), false);
});

test("the live subscription exists only while the session is established", () => {
  // Outside the initialized provider tree there is no reactive client, so
  // the subscribing component may mount only behind the signed-in guard.
  assert.match(
    surfaceSource,
    /status === "signed_in" \? \(\s*<AccessDecisionSubscription onDecision=\{setLiveDecision\} \/>\s*\) : null/,
  );
  // A session change drops the previous session's answer.
  assert.match(
    surfaceSource,
    /if \(status !== "signed_in"\) setLiveDecision\(null\);/,
  );
});

test("an approval navigates into the product exactly once, with no re-login", () => {
  assert.match(surfaceSource, /const entered = useRef\(false\);/);
  assert.match(
    surfaceSource,
    /if \(notice\.kind !== "enter" \|\| entered\.current\) return;\s*entered\.current = true;\s*router\.replace\(notice\.destination\);/,
  );
  assert.doesNotMatch(surfaceSource, /window\.location\.reload/);
});

test("decision changes re-title the document to the presented state", () => {
  assert.match(surfaceSource, /document\.title = notice\.documentTitle;/);
});

test("the surface asks the boundary to establish the server-verified session, without login intent", () => {
  assert.match(
    surfaceSource,
    /const requestSessionBoot = auth\.requestSessionBoot;\s*useEffect\(\(\) => \{\s*requestSessionBoot\(\);\s*\}, \[requestSessionBoot\]\);/,
  );
});

test("sign-out and switch-identity are wired through the existing session context", () => {
  assert.match(surfaceSource, /await auth\.logout\(\);/);
  // Both destinations run the one shared follow-up: sign out leaves for the
  // landing page the server now serves, switching identity asks for a fresh
  // sign-in from right here. Which is which is decided in
  // components/auth/sign-out-handoff, not duplicated in this component.
  assert.match(
    surfaceSource,
    /runSignOutFollowUp\(signOutFollowUp\(settled\), browserSignOutEffects\(auth\.login\)\)/,
  );
  assert.equal(surfaceSource.match(/runSignOutFollowUp\(/g)?.length, 1);
  assert.match(surfaceSource, /signOutThen\("landing"\)/);
  assert.match(surfaceSource, /signOutThen\("sign_in"\)/);
});

test("leaving after a sign-out replaces the document instead of the route", () => {
  // The router this surface holds is for the approval redirect only. Sending
  // a sign-out through it keeps the document, and with it the client
  // router's per-document cache of every segment this tab rendered; a
  // back/forward traversal reads that cache with staleness checks bypassed,
  // so one Back press restores an admitted page with no request and no gate.
  const signOutAt = surfaceSource.indexOf("async function signOutThen(");
  assert.notEqual(signOutAt, -1);
  assert.equal(surfaceSource.includes('router.replace("/")'), false);
  assert.equal(surfaceSource.includes("router.refresh"), false);
  assert.equal(surfaceSource.includes("window.location"), false);
  // The only router call left is the approval redirect, and it is above the
  // sign-out handler.
  const routerCalls = surfaceSource.match(/router\.(replace|push|refresh)\(/g);
  assert.deepEqual(routerCalls, ["router.replace("]);
  assert.ok(surfaceSource.indexOf("router.replace(") < signOutAt);
});

test("a failed sign-out settles as failed and still reaches the follow-up", () => {
  // Sign-out clears the server-readable credential in a `finally`, so a
  // failed provider call has still signed this person out server-side.
  // Returning early from the catch left them on a page rendered for a
  // session that no longer exists; the follow-up decides what each
  // destination does with a failure.
  assert.match(
    surfaceSource,
    /\} catch \{[\s\S]*?settled = \{ type: "failed", next \};\s*\}/,
  );
  const catchAt = surfaceSource.indexOf("} catch {");
  const followUpAt = surfaceSource.indexOf("runSignOutFollowUp(");
  assert.ok(catchAt !== -1);
  assert.ok(followUpAt > catchAt);
  assert.equal(
    /\breturn;/.test(surfaceSource.slice(catchAt, followUpAt)),
    false,
  );
});

test("a fresh sign-in is offered only once the session has actually ended", () => {
  const signInButton = surfaceSource.indexOf('controls.kind === "sign_in"');
  assert.notEqual(signInButton, -1);
  // The sign-in control renders only in that branch — a held session is
  // never handed a sign-in that would loop back here.
  const buttons = surfaceSource.match(/ACCESS_CONTROL_COPY\.signIn\b/g) ?? [];
  assert.equal(buttons.length, 1);
  assert.ok(surfaceSource.indexOf("ACCESS_CONTROL_COPY.signIn") > signInButton);
});

test("the identity display renders from the session context, never from the provider SDK", () => {
  assert.equal(surfaceSource.includes("@privy-io"), false);
  assert.match(surfaceSource, /usePackScoutAuth\(\)/);
  assert.match(surfaceSource, /identity: auth\.identity,/);
});

test("the accessibility contract holds: one focusable heading, live announcements, visible status", () => {
  const headings = surfaceSource.match(/<h1[\s\S]*?>/g) ?? [];
  assert.ok(headings.length > 0);
  for (const heading of headings) {
    assert.match(heading, /data-route-heading/);
    assert.match(heading, /id="access-holding-heading"/);
    assert.match(heading, /tabIndex=\{-1\}/);
  }
  assert.match(
    surfaceSource,
    /aria-labelledby="access-holding-heading"/,
  );
  assert.match(surfaceSource, /aria-live="polite"/);
  assert.match(surfaceSource, /role="status"/);
  assert.match(surfaceSource, /className="sr-only"/);
});

test("the route hands the surface the server-resolved reason and nothing else", () => {
  assert.match(
    pageSource,
    /import \{ AccessHoldingNotice \} from "@\/components\/access\/AccessHoldingNotice\.client";/,
  );
  assert.match(pageSource, /<AccessHoldingNotice reason=\{route\.reason\} \/>/);
  assert.equal(pageSource.includes("searchParams"), false);
});
