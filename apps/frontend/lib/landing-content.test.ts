import assert from "node:assert/strict";
import test from "node:test";
import { LANDING_COPY, LANDING_METADATA } from "./landing-content";
import { presentLandingAccessAction } from "@/components/landing/landing-presentation";

function collectStrings(value: unknown, collected: string[] = []): string[] {
  if (typeof value === "string") {
    collected.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, collected);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) collectStrings(entry, collected);
  }
  return collected;
}

const allCopy = collectStrings(LANDING_COPY).join("\n");

test("the landing copy states plainly what PackScout is", () => {
  assert.match(LANDING_COPY.lede, /PackScout is a market-intelligence dashboard/);
  assert.match(LANDING_COPY.lede, /repack/i);
  assert.match(LANDING_COPY.lede, /estimated expected value/i);
  assert.equal(LANDING_COPY.valuePoints.length, 3);
  for (const point of LANDING_COPY.valuePoints) {
    assert.ok(point.title.length > 0);
    assert.ok(point.body.length > 0);
  }
});

test("the closed-beta statement is honest about both admission paths", () => {
  // The page no longer carries a prose beta statement: the eyebrow names the
  // closed beta and the call to action names what pressing it does. What must
  // never be lost is that a stranger is told, before signing in, that this is
  // a beta and that signing in is a request rather than an entry.
  assert.match(LANDING_COPY.eyebrow, /closed beta/i);
  const signedOutAction = presentLandingAccessAction("signed_out");
  // With the beta prose gone, this label is the whole promise a stranger
  // reads before signing in: it is a request, not an entry.
  assert.match(signedOutAction.label, /request access/i);
  // The sign-in record is the access request: no waitlist, no lead capture.
});

test("the copy never overclaims what estimates can do", () => {
  assert.doesNotMatch(allCopy, /guarantee/i);
  assert.doesNotMatch(allCopy, /profit/i);
  assert.doesNotMatch(allCopy, /\bwin\b/i);
  assert.match(LANDING_COPY.disclaimer, /not financial advice/i);
  assert.match(LANDING_COPY.disclaimer, /risk/i);
  // The EV claim always travels with its qualifier.
  assert.match(allCopy, /long-run estimate/i);
});

test("the marketing metadata is meaningful and stays indexable", () => {
  const title = LANDING_METADATA.title as { absolute: string };
  assert.match(title.absolute, /PackScout/);
  assert.match(title.absolute, /repack/i);

  const description = LANDING_METADATA.description ?? "";
  assert.ok(
    description.length >= 50 && description.length <= 170,
    `description should read like a search snippet, got ${description.length} characters`,
  );
  assert.match(description, /closed beta/i);
  assert.match(description, /sign in/i);

  // Indexability is the landing page's job; de-indexing gated surfaces is 007's.
  assert.equal(LANDING_METADATA.robots, undefined);
});

test("social metadata mirrors the page identity", () => {
  const title = LANDING_METADATA.title as { absolute: string };
  assert.equal(LANDING_METADATA.openGraph?.title, title.absolute);
  assert.equal(
    LANDING_METADATA.openGraph?.description,
    LANDING_METADATA.description,
  );
  assert.equal(LANDING_METADATA.openGraph?.siteName, "PackScout");
  assert.equal(
    (LANDING_METADATA.openGraph as { type?: string } | undefined)?.type,
    "website",
  );
  assert.equal(
    (LANDING_METADATA.twitter as { card?: string } | undefined)?.card,
    "summary",
  );
  assert.equal(LANDING_METADATA.twitter?.title, title.absolute);
  assert.equal(
    LANDING_METADATA.twitter?.description,
    LANDING_METADATA.description,
  );
});
