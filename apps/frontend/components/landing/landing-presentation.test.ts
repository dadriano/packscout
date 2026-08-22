import assert from "node:assert/strict";
import test from "node:test";
import type { PackScoutAuthStatus } from "@/components/auth/AuthContext.client";
import {
  presentLandingAccessAction,
  type LandingAccessAction,
} from "./landing-presentation";

/**
 * The record type forces this map to name every authentication status, so a
 * new status fails the typecheck here until the landing page decides what
 * its one action means for it.
 */
const expectedKinds: Record<PackScoutAuthStatus, LandingAccessAction["kind"]> = {
  signed_out: "sign_in",
  loading: "busy",
  signed_in: "enter",
  error: "enter",
  unavailable: "unavailable",
};

test("every authentication status maps to one presentable action", () => {
  for (const [status, kind] of Object.entries(expectedKinds)) {
    const action = presentLandingAccessAction(status as PackScoutAuthStatus);
    assert.equal(action.kind, kind, `status ${status}`);
    assert.ok(action.label.length > 0, `status ${status} needs a label`);
    assert.ok(action.note.length > 0, `status ${status} needs a note`);
  }
});

test("a signed-out visitor is offered the sign-in that is the access request", () => {
  const action = presentLandingAccessAction("signed_out");
  assert.equal(action.kind, "sign_in");
  assert.equal(action.label, "Sign in to request access");
  assert.match(action.note, /access request/i);
});

test("a booting session keeps the slot busy without claiming anything", () => {
  const action = presentLandingAccessAction("loading");
  assert.equal(action.kind, "busy");
  assert.match(action.label, /checking sign-in/i);
});

test("a signed-in visitor is never looped through a second sign-in", () => {
  const action = presentLandingAccessAction("signed_in");
  assert.equal(action.kind, "enter");
  assert.equal(action.kind === "enter" && action.href, "/");
  assert.match(action.note, /already signed in/i);
  assert.doesNotMatch(action.label, /sign in/i);
});

test("an unverifiable session gets a way forward, not a dead retry", () => {
  const action = presentLandingAccessAction("error");
  assert.equal(action.kind, "enter");
  assert.equal(action.kind === "enter" && action.href, "/");
  assert.match(action.note, /sign out/i);
});

test("unconfigured authentication says so instead of dangling a button", () => {
  const action = presentLandingAccessAction("unavailable");
  assert.equal(action.kind, "unavailable");
  assert.match(action.label, /unavailable/i);
});

test("only a signed-out visitor is ever asked to sign in", () => {
  for (const status of Object.keys(expectedKinds) as PackScoutAuthStatus[]) {
    const action = presentLandingAccessAction(status);
    if (status === "signed_out") {
      assert.equal(action.kind, "sign_in");
    } else {
      assert.notEqual(action.kind, "sign_in", `status ${status} must not loop`);
    }
  }
});
