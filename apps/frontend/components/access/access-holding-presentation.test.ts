import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackScoutAuthStatus } from "@/components/auth/AuthContext.client";
import {
  ACCESS_HOLDING_COPY,
  type AccessHoldingReason,
} from "@/lib/access-holding-content";
import {
  accessDocumentTitle,
  initialAccessSessionObservation,
  observeAccessSessionStatus,
  presentAccessControls,
  presentAccessIdentity,
  presentAccessNotice,
  type AccessSessionObservation,
} from "./access-holding-presentation";

const REASONS: readonly AccessHoldingReason[] = [
  "awaiting_review",
  "declined",
  "suspended",
  "undetermined",
];

function observed(
  statuses: readonly PackScoutAuthStatus[],
): AccessSessionObservation {
  return statuses.reduce(observeAccessSessionStatus, initialAccessSessionObservation);
}

// --- The live reaction ------------------------------------------------------

test("an approval arriving while the surface is open moves the visitor into the product without a re-login", () => {
  for (const serverReason of REASONS) {
    const presentation = presentAccessNotice({
      serverReason,
      liveDecision: { admitted: true, reason: "approved" },
    });
    assert.equal(presentation.kind, "enter", serverReason);
    if (presentation.kind !== "enter") continue;
    assert.equal(presentation.destination, "/", serverReason);
    // The moment is announced; nothing asks the person to sign in again.
    assert.ok(presentation.announcement.length > 0);
    assert.doesNotMatch(presentation.announcement, /sign in/i);
  }
});

test("a decline arriving while the surface is open swaps the notice and its document title in place", () => {
  const presentation = presentAccessNotice({
    serverReason: "awaiting_review",
    liveDecision: { admitted: false, reason: "declined" },
  });
  assert.equal(presentation.kind, "notice");
  assert.equal(presentation.kind === "notice" && presentation.state, "declined");
  assert.equal(presentation.documentTitle, accessDocumentTitle("declined"));
  assert.equal(
    presentation.announcement,
    ACCESS_HOLDING_COPY.declined.heading,
  );
});

test("a suspension arriving lands on the suspension notice, never on review wording", () => {
  const presentation = presentAccessNotice({
    serverReason: "awaiting_review",
    liveDecision: { admitted: false, reason: "suspended" },
  });
  assert.equal(presentation.kind === "notice" && presentation.state, "suspended");
  assert.equal(presentation.documentTitle, accessDocumentTitle("suspended"));
});

test("without a live answer the server-resolved reason stands, silently", () => {
  for (const serverReason of REASONS) {
    const presentation = presentAccessNotice({
      serverReason,
      liveDecision: null,
    });
    assert.equal(presentation.kind === "notice" && presentation.state, serverReason);
    assert.equal(presentation.announcement, null);
  }
});

test("a live answer matching the rendered state announces nothing", () => {
  const presentation = presentAccessNotice({
    serverReason: "awaiting_review",
    liveDecision: { admitted: false, reason: "awaiting_review" },
  });
  assert.equal(presentation.kind === "notice" && presentation.state, "awaiting_review");
  assert.equal(presentation.announcement, null);
});

test("a live answer that itself cannot be resolved presents the temporary-problem state", () => {
  const presentation = presentAccessNotice({
    serverReason: "awaiting_review",
    liveDecision: { admitted: false, reason: "undetermined" },
  });
  assert.equal(presentation.kind === "notice" && presentation.state, "undetermined");
});

test("an impossible live shape changes nothing", () => {
  // The backend's validator pairs "approved" exclusively with admitted, so a
  // non-admitted "approved" cannot occur; if it ever did, the surface keeps
  // the server-resolved notice rather than inventing a state.
  const presentation = presentAccessNotice({
    serverReason: "declined",
    liveDecision: { admitted: false, reason: "approved" },
  });
  assert.equal(presentation.kind === "notice" && presentation.state, "declined");
});

test("every state carries its own document title", () => {
  const titles = [...REASONS, "approved" as const].map(accessDocumentTitle);
  assert.equal(new Set(titles).size, titles.length);
  for (const title of titles) assert.match(title, / · PackScout$/);
});

// --- The session observation ------------------------------------------------

test("a pre-boot signed-out reading is never presented as being signed out", () => {
  const identity = presentAccessIdentity({
    status: "signed_out",
    identity: null,
    observation: initialAccessSessionObservation,
  });
  assert.deepEqual(identity, { kind: "checking" });
  const controls = presentAccessControls({
    status: "signed_out",
    observation: initialAccessSessionObservation,
  });
  assert.equal(controls.kind, "session");
});

test("after the provider has booted, signed out is a settled fact", () => {
  const observation = observed(["signed_out", "loading", "signed_out"]);
  assert.deepEqual(
    presentAccessIdentity({ status: "signed_out", identity: null, observation }),
    { kind: "signed_out" },
  );
  assert.deepEqual(
    presentAccessControls({ status: "signed_out", observation }),
    { kind: "sign_in" },
  );
});

test("signing out after an established session offers sign-in — how switching identity completes", () => {
  const observation = observed(["loading", "signed_in", "signed_out"]);
  assert.deepEqual(
    presentAccessControls({ status: "signed_out", observation }),
    { kind: "sign_in" },
  );
});

// --- The identity display ---------------------------------------------------

test("an established session shows exactly the verified attributes", () => {
  const identity = presentAccessIdentity({
    status: "signed_in",
    identity: { email: "collector@example.com", walletAddress: null },
    observation: observed(["loading", "signed_in"]),
  });
  assert.deepEqual(identity, {
    kind: "identity",
    email: "collector@example.com",
    walletAddress: null,
  });
});

test("a verifying session keeps showing its attributes instead of flickering", () => {
  const identity = presentAccessIdentity({
    status: "loading",
    identity: { email: null, walletAddress: "0xAbC" },
    observation: observed(["loading", "signed_in", "loading"]),
  });
  assert.deepEqual(identity, {
    kind: "identity",
    email: null,
    walletAddress: "0xAbC",
  });
});

test("session error and unavailable are their own identity readings", () => {
  const observation = observed(["loading"]);
  assert.deepEqual(
    presentAccessIdentity({ status: "error", identity: null, observation }),
    { kind: "session_error" },
  );
  assert.deepEqual(
    presentAccessIdentity({ status: "unavailable", identity: null, observation }),
    { kind: "unavailable" },
  );
});

// --- The controls -----------------------------------------------------------

test("a standing session gets sign-out and switch-identity, never a sign-in loop", () => {
  const observation = observed(["loading", "signed_in"]);
  const controls = presentAccessControls({ status: "signed_in", observation });
  assert.deepEqual(controls, {
    kind: "session",
    signOutEnabled: true,
    switchEnabled: true,
  });
});

test("an unverifiable session can still sign out", () => {
  const observation = observed(["loading", "error"]);
  const controls = presentAccessControls({ status: "error", observation });
  assert.deepEqual(controls, {
    kind: "session",
    signOutEnabled: true,
    switchEnabled: false,
  });
});

test("controls stay inert while the session is still being established", () => {
  const controls = presentAccessControls({
    status: "loading",
    observation: observed(["loading"]),
  });
  assert.deepEqual(controls, {
    kind: "session",
    signOutEnabled: false,
    switchEnabled: false,
  });
});
