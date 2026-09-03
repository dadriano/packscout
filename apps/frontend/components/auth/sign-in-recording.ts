/**
 * Sign-in recording keeps the product-user directory current without adding
 * any user-visible step to sign-in.
 *
 * The directory mutation is idempotent server-side, so one *completed* write
 * per established session is all the directory needs. These helpers hold the
 * attempt bookkeeping and the failure containment as plain values so the
 * provider effect stays a thin binding.
 *
 * The case worth naming is the write that does not complete. Recording is the
 * only route by which a signup reaches the directory, so counting an attempt
 * as done the moment it is sent would let one dropped connection leave that
 * account missing for the whole session. The state therefore keeps a write in
 * flight, a write that succeeded, and a write that failed apart from one
 * another: only success ends the session's recording, while a failure is
 * allowed a small fixed number of further attempts, spaced out so an
 * unreachable backend is asked again rather than hammered. When that budget is
 * spent the session stops for good; the next established session starts a
 * fresh one, so nothing here has to be exhaustive.
 */

/** Where a session's directory write has got to. */
export type SignInRecordingPhase = "idle" | "pending" | "recorded" | "failed";

export type SignInRecordingState = Readonly<{
  /** The session these attempts belong to; null before any session. */
  sessionKey: string | null;
  phase: SignInRecordingPhase;
  /** Attempts started for this session, settled or not. */
  attempts: number;
}>;

/** How a settled attempt turned out. Neither outcome reaches the person. */
export type SignInRecordingOutcome = "recorded" | "failed";

export type SignInSessionObservation = Readonly<{
  signedIn: boolean;
  sessionKey: string;
}>;

export type SignInRecordingDecision = Readonly<{
  state: SignInRecordingState;
  record: boolean;
}>;

export type SignInRecordingSettlement = Readonly<{
  state: SignInRecordingState;
  /**
   * How long to wait before the session tries again, or null when it should
   * not: the write is done, the budget is spent, or the session has moved on.
   */
  retryDelayMs: number | null;
}>;

/**
 * The wait before each retry. The length of this list is the retry budget: a
 * session starts one attempt, then at most one more per entry. The waits are
 * long enough that a backend that just failed is given room to recover, and
 * short enough that the retry still lands inside an ordinary visit.
 */
export const SIGN_IN_RECORDING_RETRY_DELAYS_MS: readonly number[] = Object
  .freeze([2_000, 8_000]);

/** Total attempts one session may start, its first attempt included. */
export const SIGN_IN_RECORDING_MAX_ATTEMPTS =
  SIGN_IN_RECORDING_RETRY_DELAYS_MS.length + 1;

export const initialSignInRecordingState: SignInRecordingState = Object.freeze({
  sessionKey: null,
  phase: "idle",
  attempts: 0,
});

/**
 * Decides whether an observed session should send the directory write now.
 *
 * A session whose write is in flight or already completed never sends another,
 * which is what keeps re-renders and Convex reconnects free. A session whose
 * last attempt failed sends again while its budget lasts, so a reconnect is
 * also a chance to recover. Any other session key ends the current session, so
 * signing out and back in — or a provider that swaps identities without a
 * signed-out render — starts over with a full budget.
 */
export function decideSignInRecording(
  state: SignInRecordingState,
  observation: SignInSessionObservation,
): SignInRecordingDecision {
  if (state.sessionKey !== observation.sessionKey) {
    if (!observation.signedIn) {
      return {
        state: state.sessionKey === null ? state : initialSignInRecordingState,
        record: false,
      };
    }
    return {
      state: {
        sessionKey: observation.sessionKey,
        phase: "pending",
        attempts: 1,
      },
      record: true,
    };
  }
  const retryable = observation.signedIn &&
    state.phase === "failed" &&
    state.attempts < SIGN_IN_RECORDING_MAX_ATTEMPTS;
  if (!retryable) return { state, record: false };
  return {
    state: {
      sessionKey: state.sessionKey,
      phase: "pending",
      attempts: state.attempts + 1,
    },
    record: true,
  };
}

/**
 * Records how an attempt turned out, and says whether to try again.
 *
 * An attempt that settles after its session has ended decides nothing: the
 * state now describes a different session, and letting a late reply write into
 * it would either mark that session recorded on another session's evidence or
 * revive one already finished.
 */
export function settleSignInRecording(
  state: SignInRecordingState,
  sessionKey: string,
  outcome: SignInRecordingOutcome,
): SignInRecordingSettlement {
  if (state.sessionKey !== sessionKey || state.phase !== "pending") {
    return { state, retryDelayMs: null };
  }
  if (outcome === "recorded") {
    return {
      state: { sessionKey, phase: "recorded", attempts: state.attempts },
      retryDelayMs: null,
    };
  }
  // Undefined past the end of the list is the budget running out.
  const nextDelayMs: number | undefined =
    SIGN_IN_RECORDING_RETRY_DELAYS_MS[state.attempts - 1];
  return {
    state: { sessionKey, phase: "failed", attempts: state.attempts },
    retryDelayMs: nextDelayMs ?? null,
  };
}

/**
 * Sends the directory write and absorbs every failure, reporting the outcome.
 *
 * The record is administrative bookkeeping: an unreachable backend, a rejected
 * mutation, or a provider that throws synchronously must leave the session,
 * saved items, and the rest of the tree untouched. So this never rejects. It
 * does say which way the attempt went, because a caller that cannot tell a
 * failure from a success has no way to try again.
 */
export async function recordSignInBestEffort(
  record: () => Promise<unknown>,
): Promise<SignInRecordingOutcome> {
  try {
    await record();
    return "recorded";
  } catch {
    // Sign-in never fails because its directory record could not be written.
    return "failed";
  }
}
