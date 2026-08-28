import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_APPROVED_NOTICE,
  ACCESS_CONTROL_COPY,
  ACCESS_HOLDING_COPY,
  ACCESS_IDENTITY_COPY,
  ACCESS_WRONG_STATE_GUIDANCE,
  type AccessHoldingReason,
} from "./access-holding-content";

const REASONS: readonly AccessHoldingReason[] = [
  "awaiting_review",
  "declined",
  "suspended",
  "undetermined",
];

test("every reason renders distinct copy in every visitor-facing field", () => {
  for (const field of ["title", "heading", "body", "detail"] as const) {
    const values = REASONS.map((reason) => ACCESS_HOLDING_COPY[reason][field]);
    assert.equal(new Set(values).size, REASONS.length, field);
  }
  // The approved moment is its own words too, not a re-dressed notice.
  assert.equal(
    REASONS.some((reason) =>
      ACCESS_HOLDING_COPY[reason].heading === ACCESS_APPROVED_NOTICE.heading ||
      ACCESS_HOLDING_COPY[reason].title === ACCESS_APPROVED_NOTICE.title
    ),
    false,
  );
});

test("waiting reads as a normal state with no invented promises", () => {
  const copy = ACCESS_HOLDING_COPY.awaiting_review;
  assert.match(copy.body, /in review|with the team/);
  assert.match(copy.body, /nothing more you need to do/i);
  for (const text of [copy.body, copy.detail]) {
    assert.doesNotMatch(text, /\bwithin \d|hours|days|minutes|shortly|soon\b/i);
    assert.doesNotMatch(text, /email you|we will contact/i);
  }
  // The live behavior is stated as what the page does, not as a delivery date.
  assert.match(copy.detail, /approved, this page brings you straight in/i);
});

test("declined is brief and respectful: no reasons, no review, no sign-in loop", () => {
  const copy = ACCESS_HOLDING_COPY.declined;
  assert.doesNotMatch(copy.body, /review/i);
  assert.match(copy.body, /not approved/);
  // No operator notes or reasoning leak, and signing in again is named as
  // the thing that will not help rather than dangled as a remedy.
  assert.doesNotMatch(`${copy.body} ${copy.detail}`, /because|reason|operator/i);
  assert.match(copy.detail, /will not change the answer/);
});

test("suspended is its own notice, never presented as review", () => {
  const copy = ACCESS_HOLDING_COPY.suspended;
  assert.doesNotMatch(copy.heading, /review/i);
  assert.doesNotMatch(copy.body, /review|queue/i);
  assert.match(copy.body, /suspended/);
  assert.match(copy.body, /separate from the beta/i);
});

test("the unresolved state is a temporary problem with a retry, separated from any decision", () => {
  const copy = ACCESS_HOLDING_COPY.undetermined;
  assert.match(copy.body, /temporary/);
  assert.match(copy.body, /not a decision/);
  assert.match(copy.detail, /Nothing about your request has changed/);
  assert.deepEqual(copy.retry, { href: "/", label: "Try again" });
  for (const reason of ["awaiting_review", "declined", "suspended"] as const) {
    assert.equal(ACCESS_HOLDING_COPY[reason].retry, null);
  }
});

test("no backend vocabulary or status codes leak into what the person reads", () => {
  const visible = [
    ...REASONS.flatMap((reason) => {
      const copy = ACCESS_HOLDING_COPY[reason];
      return [copy.title, copy.kicker, copy.heading, copy.body, copy.detail];
    }),
    ...Object.values(ACCESS_APPROVED_NOTICE),
    ...Object.values(ACCESS_IDENTITY_COPY),
    ...Object.values(ACCESS_CONTROL_COPY),
    ACCESS_WRONG_STATE_GUIDANCE,
  ];
  for (const text of visible) {
    assert.doesNotMatch(text, /undetermined|awaiting_review|AUTH|_|[0-9]{3}/);
    assert.doesNotMatch(text, /convex|backend|token|cookie|allowlist/i);
  }
});

test("the surface's own controls cover sign-out and switching identity", () => {
  assert.match(ACCESS_CONTROL_COPY.signOut, /^Sign out$/);
  assert.match(ACCESS_CONTROL_COPY.switchIdentity, /different address/i);
  assert.notEqual(
    ACCESS_CONTROL_COPY.signOut,
    ACCESS_CONTROL_COPY.switchIdentity,
  );
  assert.match(ACCESS_CONTROL_COPY.signOutFailed, /try again/i);
});

test("identity copy shows only verified attributes and separates checking from signed out", () => {
  assert.match(ACCESS_IDENTITY_COPY.legend, /signed in as/i);
  assert.notEqual(ACCESS_IDENTITY_COPY.checking, ACCESS_IDENTITY_COPY.signedOut);
  assert.match(ACCESS_IDENTITY_COPY.checking, /checking/i);
  assert.match(ACCESS_IDENTITY_COPY.signedOut, /signed out/i);
  // A session that exposed nothing is said plainly, never invented.
  assert.match(ACCESS_IDENTITY_COPY.noneExposed, /did not share/i);
});

test("the wrong-state guidance uses paths that exist instead of inventing support", () => {
  assert.match(ACCESS_WRONG_STATE_GUIDANCE, /exact email or wallet address/i);
  // The human path is conditional on an inviter existing, so it stays honest
  // for people who simply signed in to request access.
  assert.match(ACCESS_WRONG_STATE_GUIDANCE, /If someone invited you/);
  assert.doesNotMatch(
    ACCESS_WRONG_STATE_GUIDANCE,
    /support@|ticket|help center|contact us/i,
  );
});
