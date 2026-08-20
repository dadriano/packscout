import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSignInRecording,
  initialSignInRecordingState,
  recordSignInBestEffort,
  type SignInSessionObservation,
} from "./sign-in-recording";

/**
 * Replays a session the way `AuthenticatedSignInRecorder`'s effect does: one
 * decision per observed status, carrying the decided state forward.
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

test("a successful directory write returns nothing to the caller", async () => {
  assert.equal(
    await recordSignInBestEffort(async () => ({
      created: true,
      standing: "active",
    })),
    undefined,
  );
});
