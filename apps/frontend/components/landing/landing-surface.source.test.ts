import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const routeSource = readFileSync(
  new URL("../../app/welcome/page.tsx", import.meta.url),
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
  routeSource,
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
  // The one shell status the standalone address reports is a static literal,
  // not a read, mirroring the dashboard's own no-data branches.
  assert.match(routeSource, /status=\{\{ state: "unavailable" \}\}/);
  assert.equal(routeSource.includes("async"), false);
  assert.equal(routeSource.includes("await"), false);
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

test("the standalone address stays additive and exports the marketing metadata", () => {
  assert.match(
    routeSource,
    /import \{ LandingPage \} from "@\/components\/landing\/LandingPage"/,
  );
  assert.match(
    routeSource,
    /import \{ LANDING_METADATA \} from "@\/lib\/landing-content"/,
  );
  assert.match(
    routeSource,
    /export const metadata: Metadata = LANDING_METADATA;/,
  );
  assert.match(routeSource, /<LandingPage \/>/);
});
