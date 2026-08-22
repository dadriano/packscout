import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_HOLDING_COPY,
  type AccessHoldingReason,
} from "./access-holding-content";

const REASONS: readonly AccessHoldingReason[] = [
  "awaiting_review",
  "declined",
  "suspended",
  "undetermined",
];

test("every reason renders distinct copy in every visitor-facing field", () => {
  for (const field of ["title", "heading", "body"] as const) {
    const values = REASONS.map((reason) => ACCESS_HOLDING_COPY[reason][field]);
    assert.equal(new Set(values).size, REASONS.length, field);
  }
});

test("waiting reads as a normal state with no invented promises", () => {
  const copy = ACCESS_HOLDING_COPY.awaiting_review;
  assert.match(copy.body, /in review|with the team/);
  assert.doesNotMatch(copy.body, /\bwithin \d|hours|days|email you/i);
});

test("declined and suspended are distinct notices, never presented as review", () => {
  assert.doesNotMatch(ACCESS_HOLDING_COPY.declined.body, /review/i);
  assert.doesNotMatch(ACCESS_HOLDING_COPY.suspended.heading, /review/i);
  assert.match(ACCESS_HOLDING_COPY.suspended.body, /suspended/);
});

test("the unresolved state is a temporary problem with a retry, separated from any decision", () => {
  const copy = ACCESS_HOLDING_COPY.undetermined;
  assert.match(copy.body, /temporary/);
  assert.match(copy.body, /not a decision/);
  assert.deepEqual(copy.retry, { href: "/", label: "Try again" });
  for (const reason of ["awaiting_review", "declined", "suspended"] as const) {
    assert.equal(ACCESS_HOLDING_COPY[reason].retry, null);
  }
});

test("no backend vocabulary or status codes leak into what the person reads", () => {
  for (const reason of REASONS) {
    const copy = ACCESS_HOLDING_COPY[reason];
    const visible = `${copy.title} ${copy.kicker} ${copy.heading} ${copy.body} ${copy.accountNote}`;
    assert.doesNotMatch(visible, /undetermined|awaiting_review|AUTH|_|[0-9]{3}/);
  }
});

test("sign-out stays reachable: every state points at the account menu", () => {
  for (const reason of REASONS) {
    assert.match(ACCESS_HOLDING_COPY[reason].accountNote, /sign out/i);
    assert.match(ACCESS_HOLDING_COPY[reason].accountNote, /account menu/);
  }
});
