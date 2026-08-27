import {
  realSignOutCeilingTimer,
  SIGN_OUT_CEILING_MS,
  type SignOutCeilingTimer,
  settleWithinSignOutCeiling,
} from "./sign-out-handoff";

export const AUTH_SESSION_HINT_KEY = "packscout.auth.returning.v1";
export const AUTH_SESSION_HINT_VALUE = "returning";

export type AuthSessionHintStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

export type AuthBootState = Readonly<{
  phase: "idle" | "loading" | "ready";
  loginRequested: boolean;
}>;

export type AuthBootEvent =
  | Readonly<{ type: "returning_session" }>
  | Readonly<{ type: "login_intent" }>
  | Readonly<{ type: "provider_loaded" }>
  | Readonly<{ type: "provider_failed" }>
  | Readonly<{ type: "login_consumed" }>;

export const initialAuthBootState: AuthBootState = Object.freeze({
  phase: "idle",
  loginRequested: false,
});

export function reduceAuthBootState(
  state: AuthBootState,
  event: AuthBootEvent,
): AuthBootState {
  if (event.type === "login_intent") {
    return {
      phase: state.phase === "idle" ? "loading" : state.phase,
      loginRequested: true,
    };
  }
  if (event.type === "returning_session") {
    return state.phase === "idle" ? { ...state, phase: "loading" } : state;
  }
  if (event.type === "provider_loaded") {
    return { ...state, phase: "ready" };
  }
  if (event.type === "provider_failed") {
    return initialAuthBootState;
  }
  return state.loginRequested
    ? { ...state, loginRequested: false }
    : state;
}

export function readReturningSessionHint(
  storage: AuthSessionHintStorage | null,
): boolean {
  if (storage === null) return false;
  try {
    const value = storage.getItem(AUTH_SESSION_HINT_KEY);
    if (value === AUTH_SESSION_HINT_VALUE) return true;
    if (value !== null) storage.removeItem(AUTH_SESSION_HINT_KEY);
  } catch {
    // Authentication remains opt-in when browser storage is unavailable.
  }
  return false;
}

export function writeReturningSessionHint(
  storage: AuthSessionHintStorage | null,
): void {
  if (storage === null) return;
  try {
    storage.setItem(AUTH_SESSION_HINT_KEY, AUTH_SESSION_HINT_VALUE);
  } catch {
    // A storage failure never blocks a valid authenticated session.
  }
}

export function clearReturningSessionHint(
  storage: AuthSessionHintStorage | null,
): void {
  if (storage === null) return;
  try {
    storage.removeItem(AUTH_SESSION_HINT_KEY);
  } catch {
    // A storage failure never changes the provider's authenticated state.
  }
}

export function syncReturningSessionHint(
  input: Readonly<{ ready: boolean; authenticated: boolean }>,
  storage: AuthSessionHintStorage | null,
): void {
  if (!input.ready) return;
  if (input.authenticated) writeReturningSessionHint(storage);
  else clearReturningSessionHint(storage);
}

/**
 * Signs out and drops the returning-session hint, whether or not the provider
 * call succeeded — and still reports the failure to the caller.
 *
 * The hint is the other half of the same credential surface as the identity
 * cookie, which sign-out already clears in a `finally` for exactly this
 * reason: a provider failure must not leave someone who asked to leave being
 * silently signed back in. Keeping the hint through a failed sign-out did
 * precisely that. The next document boots the provider on the hint alone, an
 * unresolved provider session comes back up, the cookie sync writes the
 * credential again, and the landing page's automatic hand-off walks the
 * visitor straight into the product seconds after they pressed Sign out. The
 * rejection still propagates, so the surface can say what happened.
 *
 * "Whether or not it succeeded" has to include "whether or not it answered",
 * which is why the provider call is wrapped in the sign-out ceiling *here*,
 * at the innermost point, rather than at the surface that awaits this. Both
 * credential clears — this hint, and the identity cookie in the `finally` of
 * the provider's own logout — sit downstream of this one await, so a bound
 * placed any further out would let the surface leave while a call that never
 * answered still held both. Reaching the ceiling settles this await, so both
 * `finally` blocks run and only then does the failure travel outward.
 */
export async function logoutAndClearReturningSessionHint(
  logout: () => Promise<void>,
  storage: AuthSessionHintStorage | null,
  ceiling: SignOutCeilingTimer = realSignOutCeilingTimer,
): Promise<void> {
  try {
    await settleWithinSignOutCeiling(logout, SIGN_OUT_CEILING_MS, ceiling);
  } finally {
    clearReturningSessionHint(storage);
  }
}

export function browserAuthSessionHintStorage(): AuthSessionHintStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function shouldInvokeLogin(input: Readonly<{
  requested: boolean;
  ready: boolean;
  authenticated: boolean;
  alreadyInvoked: boolean;
}>): boolean {
  return (
    input.requested &&
    input.ready &&
    !input.authenticated &&
    !input.alreadyInvoked
  );
}
