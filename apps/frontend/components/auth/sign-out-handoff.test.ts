import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCESS_CONTROL_COPY } from "@/lib/access-holding-content";
import {
  browserSignOutEffects,
  presentSignOutControl,
  reduceSignOut,
  runSignOutFollowUp,
  SIGN_OUT_CEILING_MS,
  SIGN_OUT_COPY,
  SIGN_OUT_NOT_CONFIRMED_MESSAGE,
  type SignOutEffects,
  type SignOutPhase,
  signOutFollowUp,
  signOutRequestAccepted,
  settleWithinSignOutCeiling,
  type SignOutCeilingTimer,
} from "./sign-out-handoff";

/**
 * The sign-out decisions both surfaces share. The account menu in the shell
 * header and the holding surface each end sessions; what happens afterwards
 * differs, and getting it wrong either strands a signed-out visitor inside
 * the product or yanks someone away mid identity-switch.
 */

type RecordedEffect =
  | Readonly<{ kind: "replace"; href: string }>
  | Readonly<{ kind: "login" }>;

function recordingEffects(): Readonly<{
  effects: SignOutEffects;
  performed: RecordedEffect[];
}> {
  const performed: RecordedEffect[] = [];
  return {
    performed,
    effects: {
      replaceDocument: (href) => performed.push({ kind: "replace", href }),
      login: () => performed.push({ kind: "login" }),
    },
  };
}

const neverSettles = () => new Promise<void>(() => undefined);

/**
 * The ceiling under test time: nothing fires until `elapse` says so, and the
 * requested delays are recorded so the constant the surfaces rely on is the
 * one actually scheduled.
 */
function fakeSignOutCeiling() {
  const requested: number[] = [];
  let due: (() => void) | null = null;
  const timer: SignOutCeilingTimer = (onDue, ms) => {
    requested.push(ms);
    due = onDue;
    return () => {
      due = null;
    };
  };
  return {
    requested,
    timer,
    get cancelled(): boolean {
      return due === null;
    },
    elapse(): void {
      assert.notEqual(due, null, "nothing scheduled a ceiling");
      due?.();
    },
  };
}

test("a completed sign-out leaves by replacing the document, not the route", () => {
  // The defect this pins: a client-router navigation keeps the document, and
  // with it the router's per-document cache of every segment this tab has
  // already rendered. A back/forward traversal reads that cache with
  // staleness checks bypassed, so one Back press after signing out restores
  // the admitted catalog verbatim — no request, no gate, product chrome and
  // all. Replacing the document discards the router along with the session.
  const followUp = signOutFollowUp({ type: "succeeded", next: "landing" });
  assert.deepEqual(followUp, {
    exit: { href: "/", discardsDocument: true },
    login: false,
  });
  assert.equal(followUp.exit?.discardsDocument, true);
});

test("switching identity stays on the page and asks for a fresh sign-in", () => {
  // The holding surface signs out and signs back in without leaving. An exit
  // here would discard the surface and the sign-in dialog.
  assert.deepEqual(signOutFollowUp({ type: "succeeded", next: "sign_in" }), {
    exit: null,
    login: true,
  });
});

test("a failed sign-out bound for the landing page leaves exactly as a completed one does", () => {
  // Sign-out clears the server-readable identity cookie and the
  // returning-session hint in `finally` blocks, so a failed provider call has
  // still signed this person out as far as the gate is concerned. Staying put
  // left them reading a fully rendered admitted page until they happened to
  // navigate — the same harm the document replacement exists to prevent. The
  // outcome of the provider call does not enter into where this goes.
  const failed = signOutFollowUp({ type: "failed", next: "landing" });
  assert.deepEqual(
    failed,
    signOutFollowUp({ type: "succeeded", next: "landing" }),
  );
  assert.deepEqual(failed, {
    exit: { href: "/", discardsDocument: true },
    login: false,
  });

  // And performing it does exactly one thing: leave. Nothing is left behind
  // for a later page to say about it.
  const { effects, performed } = recordingEffects();
  runSignOutFollowUp(failed, effects);
  assert.deepEqual(performed, [{ kind: "replace", href: "/" }]);
});

test("a failed identity switch stays put and never opens a sign-in", () => {
  // Staying is this destination's whole contract, the visitor is on the
  // holding surface rather than inside the product, that surface renders no
  // admitted data, and the message is actionable exactly where they are.
  assert.deepEqual(signOutFollowUp({ type: "failed", next: "sign_in" }), {
    exit: null,
    login: false,
  });
  assert.deepEqual(signOutFollowUp({ type: "requested" }), {
    exit: null,
    login: false,
  });
});

test("a failed identity switch reaches the person and re-enables the controls", () => {
  const failed = reduceSignOut("pending", { type: "failed", next: "sign_in" });
  assert.equal(failed, "failed");
  const control = presentSignOutControl(failed);
  assert.equal(control.disabled, false);
  assert.equal(control.label, SIGN_OUT_COPY.signOut);
  assert.match(control.status, /try again/i);
});

test("a failed sign-out bound for the landing page stays busy, because it is leaving", () => {
  // Re-offering "Sign out" on a page that is about to be replaced would
  // invite a press that does nothing.
  const leaving = reduceSignOut("pending", { type: "failed", next: "landing" });
  assert.equal(leaving, "leaving");
  const control = presentSignOutControl(leaving);
  assert.equal(control.disabled, true);
  assert.equal(control.label, SIGN_OUT_COPY.signOutBusy);
});

test("a second press is ignored while a sign-out is running or leaving", () => {
  assert.equal(signOutRequestAccepted("idle"), true);
  assert.equal(signOutRequestAccepted("failed"), true);
  assert.equal(signOutRequestAccepted("pending"), false);
  assert.equal(signOutRequestAccepted("leaving"), false);
  // The reducer refuses the same repeats, so no call site can double-exit by
  // pressing twice.
  assert.equal(reduceSignOut("pending", { type: "requested" }), "pending");
  assert.equal(reduceSignOut("leaving", { type: "requested" }), "leaving");
  assert.equal(reduceSignOut("idle", { type: "requested" }), "pending");
  assert.equal(reduceSignOut("failed", { type: "requested" }), "pending");
});

test("the control stays busy across the hand-off, not just during the sign-out", () => {
  // The session is already gone while the exit is in flight, so re-offering
  // "Sign out" would be a lie.
  const leaving = reduceSignOut("pending", {
    type: "succeeded",
    next: "landing",
  });
  assert.equal(leaving, "leaving");
  const control = presentSignOutControl(leaving);
  assert.equal(control.disabled, true);
  assert.equal(control.label, SIGN_OUT_COPY.signOutBusy);
  assert.equal(control.status, "");
});

test("an identity switch returns the control to idle so the page stays usable", () => {
  const settled = reduceSignOut("pending", {
    type: "succeeded",
    next: "sign_in",
  });
  assert.equal(settled, "idle");
  assert.equal(presentSignOutControl(settled).disabled, false);
});

test("every phase presents a label, and only the failed one announces", () => {
  const phases: SignOutPhase[] = ["idle", "pending", "leaving", "failed"];
  for (const phase of phases) {
    const control = presentSignOutControl(phase);
    assert.ok(control.label.length > 0, phase);
    assert.equal(control.status === "", phase !== "failed", phase);
  }
});

test("the shared sign-out sentences are the holding surface's sentences", () => {
  // Two surfaces, one wording: the copy cannot drift into two versions of
  // the same sentence.
  assert.equal(SIGN_OUT_COPY.signOut, ACCESS_CONTROL_COPY.signOut);
  assert.equal(SIGN_OUT_COPY.signOutBusy, ACCESS_CONTROL_COPY.signOutBusy);
  assert.equal(SIGN_OUT_COPY.signOutFailed, ACCESS_CONTROL_COPY.signOutFailed);
});

test("performing a completed sign-out replaces the document and nothing else", () => {
  // The performer is what both surfaces call, so a soft navigation cannot be
  // reintroduced at one call site without failing here.
  const { effects, performed } = recordingEffects();
  runSignOutFollowUp(
    signOutFollowUp({ type: "succeeded", next: "landing" }),
    effects,
  );
  assert.deepEqual(performed, [{ kind: "replace", href: "/" }]);
});

test("performing an identity switch opens a sign-in and never leaves", () => {
  const { effects, performed } = recordingEffects();
  runSignOutFollowUp(
    signOutFollowUp({ type: "succeeded", next: "sign_in" }),
    effects,
  );
  assert.deepEqual(performed, [{ kind: "login" }]);

  const failedSwitch = recordingEffects();
  runSignOutFollowUp(
    signOutFollowUp({ type: "failed", next: "sign_in" }),
    failedSwitch.effects,
  );
  assert.deepEqual(failedSwitch.performed, []);
});

test("a sign-out that never answers is abandoned at the ceiling", async () => {
  // The defect this pins: the provider's sign-out is not written to give up,
  // so a promise that never settles pins the control at "Signing out…",
  // disabled, for the life of the document — no exit, no announcement, no
  // retry, and no second press accepted. Reaching the ceiling turns that dead
  // control back into a settled sign-out that leaves.
  const ceiling = fakeSignOutCeiling();
  const pinned = settleWithinSignOutCeiling(
    neverSettles,
    SIGN_OUT_CEILING_MS,
    ceiling.timer,
  );
  assert.deepEqual(ceiling.requested, [SIGN_OUT_CEILING_MS]);
  ceiling.elapse();
  await assert.rejects(pinned, {
    message: SIGN_OUT_NOT_CONFIRMED_MESSAGE,
  });
});

test("the ceiling is a bound, not a deadline: a settled sign-out keeps its own answer", async () => {
  // A sign-out that merely takes a moment must not be cut short and
  // mislabelled — for the identity switch that would report a failure to
  // someone whose sign-out worked. And a provider that refuses reports its
  // own reason, not the ceiling's.
  const completed = fakeSignOutCeiling();
  await settleWithinSignOutCeiling(
    async () => undefined,
    SIGN_OUT_CEILING_MS,
    completed.timer,
  );
  // Cancelled, so nothing rejects behind a race that already settled.
  assert.equal(completed.cancelled, true);

  const refused = fakeSignOutCeiling();
  await assert.rejects(
    settleWithinSignOutCeiling(
      async () => {
        throw new Error("provider unavailable");
      },
      SIGN_OUT_CEILING_MS,
      refused.timer,
    ),
    { message: "provider unavailable" },
  );
  assert.equal(refused.cancelled, true);
});

test("the ceiling leaves room for a slow network but not for a dead control", () => {
  // Long enough that a slow round trip settles inside it, short enough that
  // nobody sits in front of a disabled control waiting on a call that is
  // never coming back.
  assert.ok(SIGN_OUT_CEILING_MS >= 5_000);
  assert.ok(SIGN_OUT_CEILING_MS <= 15_000);
});

test("the browser effects hand the surfaces a document replacement, never a router", () => {
  // The one place the exit is spelled. Both surfaces take it from here, so
  // neither holds a router it could navigate with instead.
  const effects = browserSignOutEffects(() => undefined);
  assert.equal(typeof effects.replaceDocument, "function");
  // The effect itself needs a document, so this one assertion reads the
  // source; everything else in this file is exercised behaviorally.
  const source = readFileSync(
    new URL("./sign-out-handoff.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /window\.location\.replace\(href\);/);
  assert.equal(source.includes("useRouter"), false);
});
