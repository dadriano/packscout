import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSignInRecording,
  initialSignInRecordingState,
  recordSignInBestEffort,
  settleSignInRecording,
  SIGN_IN_RECORDING_MAX_ATTEMPTS,
  SIGN_IN_RECORDING_RETRY_DELAYS_MS,
  type SignInRecordingOutcome,
  type SignInSessionObservation,
} from "./sign-in-recording";

/**
 * Replays the decisions `AuthenticatedSignInRecorder`'s effect makes when no
 * write ever settles: one decision per observed status, carrying the decided
 * state forward. This is the in-flight case on its own — a session must not
 * send a second write while its first is still out.
 */
function recordedSessions(
  observations: readonly SignInSessionObservation[],
): readonly string[] {
  let state = initialSignInRecordingState;
  const recorded: string[] = [];
  for (const observation of observations) {
    const decision = decideSignInRecording(state, observation);
    state = decision.state;
    if (decision.record) recorded.push(observation.sessionKey);
  }
  return recorded;
}

type Attempt = Readonly<{ sessionKey: string; delayMs: number | null }>;

/**
 * Replays the whole effect: each attempt settles with the outcome the backend
 * gave, and any retry the settlement asks for runs as the scheduled timer
 * would, against the same session. Returns one entry per attempt sent, with
 * the wait the session asked for afterwards.
 */
function replay(
  observations: readonly SignInSessionObservation[],
  outcomeFor: (attemptNumber: number) => SignInRecordingOutcome,
): readonly Attempt[] {
  let state = initialSignInRecordingState;
  const attempts: Attempt[] = [];
  const run = (observation: SignInSessionObservation): void => {
    const decision = decideSignInRecording(state, observation);
    state = decision.state;
    if (!decision.record) return;
    const settled = settleSignInRecording(
      state,
      observation.sessionKey,
      outcomeFor(attempts.length + 1),
    );
    state = settled.state;
    attempts.push({
      sessionKey: observation.sessionKey,
      delayMs: settled.retryDelayMs,
    });
    if (settled.retryDelayMs !== null) run(observation);
  };
  for (const observation of observations) run(observation);
  return attempts;
}

test("an established session records the directory write exactly once", () => {
  assert.deepEqual(
    recordedSessions([
      { signedIn: false, sessionKey: "loading" },
      { signedIn: false, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
    ]),
    ["signed-in:user-a"],
  );
});

test("reconnecting inside one session does not record again", () => {
  assert.deepEqual(
    recordedSessions([
      { signedIn: true, sessionKey: "signed-in:user-a" },
      // Convex re-authenticating flips the bridge back to loading and returns.
      { signedIn: false, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: false, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
    ]),
    ["signed-in:user-a"],
  );
});

test("a visitor who never signs in never records", () => {
  assert.deepEqual(
    recordedSessions([
      { signedIn: false, sessionKey: "loading" },
      { signedIn: false, sessionKey: "signed-out" },
      { signedIn: false, sessionKey: "signed-out" },
      { signedIn: false, sessionKey: "loading" },
    ]),
    [],
  );
});

test("signing out and back in records the returning session once more", () => {
  assert.deepEqual(
    recordedSessions([
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: false, sessionKey: "signed-out" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
    ]),
    ["signed-in:user-a", "signed-in:user-a"],
  );
});

test("swapping identities without a signed-out render records the new session", () => {
  assert.deepEqual(
    recordedSessions([
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-b" },
      { signedIn: true, sessionKey: "signed-in:user-b" },
    ]),
    ["signed-in:user-a", "signed-in:user-b"],
  );
});

test("one transient failure does not cost this signup the whole session", () => {
  // Recording is the only route into the directory, so a write that was sent
  // and rejected is not a write that happened. The session tries again.
  const attempts = replay(
    [{ signedIn: true, sessionKey: "signed-in:user-a" }],
    (attemptNumber) => (attemptNumber === 1 ? "failed" : "recorded"),
  );
  assert.deepEqual(attempts.map((attempt) => attempt.sessionKey), [
    "signed-in:user-a",
    "signed-in:user-a",
  ]);
  // The retry waits rather than spinning against a backend that just failed.
  assert.equal(attempts[0].delayMs, SIGN_IN_RECORDING_RETRY_DELAYS_MS[0]);
  // The write that completed ends the session's recording for good.
  assert.equal(attempts[1].delayMs, null);
});

test("a session that keeps failing gives up instead of retrying forever", () => {
  const attempts = replay(
    [{ signedIn: true, sessionKey: "signed-in:user-a" }],
    () => "failed",
  );
  assert.equal(attempts.length, SIGN_IN_RECORDING_MAX_ATTEMPTS);
  // Every retry is preceded by a real wait, and the last attempt asks for none.
  assert.deepEqual(attempts.map((attempt) => attempt.delayMs), [
    ...SIGN_IN_RECORDING_RETRY_DELAYS_MS,
    null,
  ]);
  assert.ok(SIGN_IN_RECORDING_RETRY_DELAYS_MS.every((ms) => ms > 0));
  assert.ok(SIGN_IN_RECORDING_MAX_ATTEMPTS >= 2);
});

test("an exhausted session sends nothing more, however often it re-renders", () => {
  const attempts = replay(
    [
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
      // A Convex reconnect flips the bridge back to loading and returns.
      { signedIn: false, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
    ],
    () => "failed",
  );
  assert.equal(attempts.length, SIGN_IN_RECORDING_MAX_ATTEMPTS);
});

test("a fresh session gets a fresh budget after an exhausted one", () => {
  // The give-up is per session, so signing in again self-heals a directory
  // that a spell of backend trouble left short of one record.
  const attempts = replay(
    [
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: false, sessionKey: "signed-out" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
    ],
    () => "failed",
  );
  assert.equal(attempts.length, SIGN_IN_RECORDING_MAX_ATTEMPTS * 2);
});

test("a completed write is never repeated by a re-render or a reconnect", () => {
  const attempts = replay(
    [
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
      { signedIn: false, sessionKey: "signed-in:user-a" },
      { signedIn: true, sessionKey: "signed-in:user-a" },
    ],
    () => "recorded",
  );
  assert.deepEqual(attempts.map((attempt) => attempt.sessionKey), [
    "signed-in:user-a",
  ]);
});

test("a write settling for a session that has ended changes nothing", () => {
  // User A's write lands after user B's session took over. It must not mark
  // B's session recorded, nor revive A's.
  const afterA = decideSignInRecording(initialSignInRecordingState, {
    signedIn: true,
    sessionKey: "signed-in:user-a",
  }).state;
  const duringB = decideSignInRecording(afterA, {
    signedIn: true,
    sessionKey: "signed-in:user-b",
  }).state;

  for (const outcome of ["recorded", "failed"] as const) {
    const stale = settleSignInRecording(duringB, "signed-in:user-a", outcome);
    assert.equal(stale.state, duringB);
    assert.equal(stale.retryDelayMs, null);
  }
  // B's own session is still owed its write, and still sends exactly one.
  assert.equal(
    decideSignInRecording(duringB, {
      signedIn: true,
      sessionKey: "signed-in:user-b",
    }).record,
    false,
  );
});

test("a rejected directory write resolves quietly and raises nothing", async () => {
  const unhandled: unknown[] = [];
  const capture = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", capture);
  try {
    let calls = 0;
    await recordSignInBestEffort(async () => {
      calls += 1;
      throw new Error("convex unavailable");
    });
    // The effect fires the write without awaiting it.
    void recordSignInBestEffort(async () => {
      calls += 1;
      throw new Error("convex unavailable");
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
  } finally {
    process.off("unhandledRejection", capture);
  }
  assert.deepEqual(unhandled, []);
});

test("a directory write that throws synchronously is contained too", async () => {
  await assert.doesNotReject(
    recordSignInBestEffort(() => {
      throw new Error("mutation unavailable");
    }),
  );
});

test("the helper reports which way an attempt went, and never rejects", async () => {
  // A caller that cannot tell a rejection from a completed write has no way
  // to try again, which is exactly how a dropped record used to become
  // permanent for the session. The distinction is reported as a value, so
  // containment and retry do not have to fight each other.
  const cases: readonly [() => Promise<unknown>, SignInRecordingOutcome][] = [
    [async () => ({ created: true, standing: "active" }), "recorded"],
    [async () => undefined, "recorded"],
    [
      async () => {
        throw new Error("convex unavailable");
      },
      "failed",
    ],
    [
      () => {
        throw new Error("mutation unavailable");
      },
      "failed",
    ],
    [() => Promise.reject(new Error("rejected")), "failed"],
  ];
  await Promise.all(
    cases.map(async ([record, expected]) => {
      assert.equal(await recordSignInBestEffort(record), expected);
    }),
  );
});
