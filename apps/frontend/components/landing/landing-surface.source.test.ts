import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("./LandingPage.tsx", import.meta.url),
  "utf8",
);
const ctaSource = readFileSync(
  new URL("./LandingAccessCta.client.tsx", import.meta.url),
  "utf8",
);
const presentationSource = readFileSync(
  new URL("./landing-presentation.ts", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(
  new URL("./Landing.module.css", import.meta.url),
  "utf8",
);
const rootRouteSource = readFileSync(
  new URL("../../app/page.tsx", import.meta.url),
  "utf8",
);
const contentSource = readFileSync(
  new URL("../../lib/landing-content.ts", import.meta.url),
  "utf8",
);

const allLandingSources = [
  pageSource,
  ctaSource,
  presentationSource,
  contentSource,
];

test("the landing surface renders one page heading with route focus semantics", () => {
  assert.equal(pageSource.match(/<h1/g)?.length, 1);
  assert.match(pageSource, /data-route-heading/);
  assert.match(pageSource, /tabIndex=\{-1\}/);
  assert.equal(ctaSource.includes("<h1"), false);
});

test("rendering the landing surface performs no catalog or authenticated read", () => {
  for (const source of allLandingSources) {
    assert.equal(source.includes("public-repacks"), false);
    assert.equal(source.includes('from "convex'), false);
    assert.equal(source.includes("@packscout/database"), false);
    assert.equal(source.includes("fetch("), false);
    assert.equal(source.includes("next/headers"), false);
  }
  // The root serves the surface from its landing branch, which returns
  // before the dashboard read: the access decision is the only thing that
  // runs ahead of it, and the branch itself renders the pared-back shell
  // face plus the static landing markup.
  const landingBranch = rootRouteSource.indexOf('route.kind === "landing"');
  const dashboardRead = rootRouteSource.indexOf("readDashboardBundle(");
  assert.ok(landingBranch !== -1 && dashboardRead !== -1);
  assert.ok(landingBranch < dashboardRead);
});

test("the provider boot stays intent-based with no eager identity dependency", () => {
  for (const source of allLandingSources) {
    assert.equal(source.includes("@privy-io"), false);
    assert.equal(source.includes("usePrivy"), false);
  }
  // The static presentation is server-renderable; only the action is a
  // client component, and it consumes the existing authentication context.
  assert.equal(pageSource.includes('"use client"'), false);
  assert.match(ctaSource, /^"use client";/);
  assert.match(
    ctaSource,
    /import \{ usePackScoutAuth \} from "@\/components\/auth\/AuthContext\.client"/,
  );
  assert.match(
    ctaSource,
    /onClick=\{action\.kind === "sign_in" \? \(\) => auth\.login\(\) : undefined\}/,
  );
  assert.match(ctaSource, /disabled=\{action\.kind !== "sign_in"\}/);
});

test("every action state renders inside one reserved slot so nothing shifts", () => {
  assert.match(ctaSource, /className=\{styles\.ctaSlot\}/);
  assert.equal(ctaSource.match(/styles\.ctaAction/g)?.length, 2);
  assert.match(stylesSource, /\.ctaSlot \{[^}]*min-height/);
  assert.match(ctaSource, /aria-live="polite"/);
});

test("the surface offers exactly one action and captures nothing", () => {
  assert.equal(pageSource.match(/<LandingAccessCta \/>/g)?.length, 1);
  for (const source of [pageSource, ctaSource]) {
    assert.equal(source.includes("<input"), false);
    assert.equal(source.includes("<form"), false);
  }
  // The static page renders no controls of its own; the client action owns
  // the only button and the only link on the surface.
  assert.equal(pageSource.includes("<button"), false);
  assert.equal(pageSource.includes("<Link"), false);
  assert.equal(pageSource.includes("href="), false);
  assert.equal(ctaSource.match(/href=/g)?.length, 1);
  assert.match(ctaSource, /href=\{action\.href\}/);
});

test("nothing on the surface points a signed-out visitor at a gated route", () => {
  for (const source of allLandingSources) {
    assert.equal(source.includes('"/learn'), false);
    assert.equal(source.includes('"/packs'), false);
  }
  // The only navigation target is the root, where the access decision lives.
  assert.match(presentationSource, /href: "\/"/);
});

test("the root is the landing surface's address and carries its marketing metadata", () => {
  // closed-beta-access/007 wired the branch: the standalone /welcome route
  // from 006 is retired because the root now serves the surface to every
  // visitor who is not admitted, so a second indexable copy would only
  // compete with it.
  assert.equal(
    existsSync(new URL("../../app/welcome", import.meta.url)),
    false,
  );
  assert.match(
    rootRouteSource,
    /import \{ LandingPage \} from "@\/components\/landing\/LandingPage"/,
  );
  assert.match(rootRouteSource, /<LandingPage \/>/);
  // The landing metadata travels through the access decision: the root's
  // generateMetadata serves LANDING_METADATA for visitors who get the
  // landing surface (asserted behaviorally in lib/access-gate.server.test.ts).
  assert.match(rootRouteSource, /rootRouteMetadata\(await resolveVisitorAccess\(\)\)/);
});

test("a completed sign-in hands off to the server instead of asking for a click", () => {
  // The visitor should not have to press Continue after signing in: only the
  // server knows whether they belong in the product or the holding surface,
  // so the surface navigates to the enter action's href and lets the gate
  // decide.
  assert.match(
    ctaSource,
    /const destination = action\.kind === "enter" \? action\.href : null;/u,
  );
  assert.match(ctaSource, /router\.replace\(destination\)/u);
  // Only a verified session is handed off automatically. An established but
  // unverifiable one would be refused by the same gate and bounce right back.
  assert.match(
    ctaSource,
    /const automatic = action\.kind === "enter" && action\.automatic;/u,
  );
  assert.match(ctaSource, /if \(!automatic \|\| destination === null/u);
});

test("the surface a sign-out lands on says nothing about it", () => {
  // Signing out replaces the document, which is what makes the exit a real
  // boundary — the client router and every cached segment go with it — and
  // which also destroys the page that would otherwise have reported a
  // failure. The answer is not to smuggle a message across that boundary:
  // the exit runs for successes and failures alike, so any message carried
  // here would attach a warning to sign-outs that worked, and one that
  // outlives its tab would attach it to a later, unrelated visit.
  assert.equal(
    existsSync(new URL("./SignOutNotice.client.tsx", import.meta.url)),
    false,
  );
  for (const source of [...allLandingSources, stylesSource]) {
    assert.equal(source.includes("SignOutNotice"), false);
    assert.equal(source.includes("signOutNotice"), false);
    assert.equal(source.includes("sessionStorage"), false);
  }
});

test("the hand-off travels with a credential of this session, not any cookie", () => {
  // Presence proves nothing: this page is what the gate serves when it
  // refused the cookie the browser still holds, so the decision is taken on
  // the value and on when this document wrote it. The rules themselves are
  // proven in lib/identity-cookie.test.ts.
  assert.match(ctaSource, /decideIdentityHandoff\(\{/u);
  assert.match(ctaSource, /cookieToken: readBrowserIdentityCookie\(\),/u);
  assert.match(ctaSource, /mountedAtMs: mountedAtMs\.current,/u);
  assert.equal(ctaSource.includes("browserHasIdentityCookie"), false);
  // Cookie writes render nothing on their own, so the surface subscribes to
  // them rather than polling a value it cannot interpret.
  assert.match(ctaSource, /useSyncExternalStore\(/u);
  assert.match(ctaSource, /subscribeToIdentityCookieWrites,/u);
});

test("the hand-off is bounded, re-armable, and leaves the link as the fallback", () => {
  // It must give up rather than retry forever, leaving the visible link as a
  // working manual fallback.
  assert.match(ctaSource, /IDENTITY_HANDOFF_TIMEOUT_MS/u);
  assert.match(ctaSource, /IDENTITY_HANDOFF_MAX_ATTEMPTS/u);
  assert.match(ctaSource, /surrendered\.current = true;/u);
  // The guard records which credential travelled, not merely that one did:
  // a spent boolean strands a signed-in visitor when the fresh credential
  // arrives after a failed attempt.
  assert.match(
    ctaSource,
    /attempted\.current = \[\.\.\.attempted\.current, decision\.token\];/u,
  );
  assert.equal(ctaSource.includes("const entered = useRef(false)"), false);
});
