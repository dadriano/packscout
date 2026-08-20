/**
 * Sign-in recording keeps the product-user directory current without adding
 * any user-visible step to sign-in.
 *
 * The directory mutation is idempotent server-side, so the frontend only has
 * to send it once per established session. These helpers hold that decision
 * and the failure containment as plain values so the provider effect stays a
 * thin binding.
 */

export type SignInRecordingState = Readonly<{
  recordedSessionKey: string | null;
}>;

export type SignInSessionObservation = Readonly<{
  signedIn: boolean;
  sessionKey: string;
}>;

export type SignInRecordingDecision = Readonly<{
  state: SignInRecordingState;
  record: boolean;
}>;

export const initialSignInRecordingState: SignInRecordingState = Object.freeze({
  recordedSessionKey: null,
});

/**
 * Decides whether an observed session still owes the directory a write.
 *
 * A session that has already been recorded never records again, which covers
 * re-renders and Convex reconnects inside one session. Any other session key
 * ends the recorded session, so signing out and back in — or a provider that
 * swaps identities without a signed-out render — records once more.
 */
export function decideSignInRecording(
  state: SignInRecordingState,
  observation: SignInSessionObservation,
): SignInRecordingDecision {
  if (state.recordedSessionKey === observation.sessionKey) {
    return { state, record: false };
  }
  if (!observation.signedIn) {
    return {
      state: state.recordedSessionKey === null
        ? state
        : initialSignInRecordingState,
      record: false,
    };
  }
  return { state: { recordedSessionKey: observation.sessionKey }, record: true };
}

/**
 * Sends the directory write and absorbs every failure.
 *
 * The record is administrative bookkeeping: an unreachable backend, a rejected
 * mutation, or a provider that throws synchronously must leave the session,
 * saved items, and the rest of the tree untouched. The next established
 * session records again, so a dropped write self-heals.
 */
export async function recordSignInBestEffort(
  record: () => Promise<unknown>,
): Promise<void> {
  try {
    await record();
  } catch {
    // Sign-in never fails because its directory record could not be written.
  }
}
