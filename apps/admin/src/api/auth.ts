import type {
  AuthSessionResponse,
  LoginRequest,
  OperatorInvitationAcceptanceRequest,
  PasswordResetCompletionRequest,
  PasswordResetRequest,
} from "@packscout/contracts";
import {
  requestJson,
  setAdminCsrfToken,
  type Fetcher,
} from "./client";

type SessionListener = (session: AuthSessionResponse | null) => void;

const sessionListeners = new Set<SessionListener>();
let currentSession: AuthSessionResponse | null = null;
let authRequestSequence = 0;

function retainSession(session: AuthSessionResponse): AuthSessionResponse {
  currentSession = session;
  setAdminCsrfToken(session.csrfToken);
  for (const listener of sessionListeners) listener(session);
  return session;
}

function clearSession(): void {
  currentSession = null;
  setAdminCsrfToken(null);
  for (const listener of sessionListeners) listener(null);
}

export function subscribeToAuthSession(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  if (currentSession) listener(currentSession);
  return () => sessionListeners.delete(listener);
}

export function login(
  input: LoginRequest,
  fetcher?: Fetcher,
): Promise<AuthSessionResponse> {
  const sequence = ++authRequestSequence;
  return requestJson<AuthSessionResponse>(
    "/auth/login",
    { method: "POST", json: input },
    fetcher,
  ).then((session) => {
    if (sequence === authRequestSequence) retainSession(session);
    return session;
  });
}

export function getSession(fetcher?: Fetcher): Promise<AuthSessionResponse> {
  const sequence = ++authRequestSequence;
  return requestJson<AuthSessionResponse>("/auth/session", {}, fetcher)
    .then((session) => {
      if (sequence === authRequestSequence) retainSession(session);
      return session;
    })
    .catch((error: unknown) => {
      if (sequence === authRequestSequence) clearSession();
      throw error;
    });
}

export function forgetAuthSession(): void {
  authRequestSequence += 1;
  clearSession();
}

export async function logout(fetcher?: Fetcher): Promise<void> {
  const sequence = ++authRequestSequence;
  await requestJson<void>("/auth/logout", { method: "POST" }, fetcher);
  if (sequence === authRequestSequence) clearSession();
}

/**
 * Asks for a one-time reset link. The server's response is identical for
 * every address — known, unknown, or rate limited — so resolving tells the
 * caller only that the request was accepted, never whether mail is coming.
 */
export function requestPasswordReset(
  input: PasswordResetRequest,
  fetcher?: Fetcher,
): Promise<void> {
  return requestJson<unknown>(
    "/auth/password-reset/request",
    { method: "POST", json: input },
    fetcher,
  ).then(() => undefined);
}

/**
 * Redeems a mailed reset link with the operator's new password. Success
 * revokes every existing session for the operator, so the caller signs in
 * fresh afterwards; a dead link rejects with code `EMAIL_LINK_INVALID`.
 */
export function completePasswordReset(
  input: PasswordResetCompletionRequest,
  fetcher?: Fetcher,
): Promise<void> {
  return requestJson<void>(
    "/auth/password-reset/complete",
    { method: "POST", json: input },
    fetcher,
  );
}

/**
 * Redeems a mailed invitation link with the password the invited person
 * chose. Success activates the account; every dead link — cancelled,
 * superseded, expired, or already used — fails with the one uniform
 * invalid-link outcome.
 */
export function acceptOperatorInvitation(
  input: OperatorInvitationAcceptanceRequest,
  fetcher?: Fetcher,
): Promise<void> {
  return requestJson<void>(
    "/auth/invitations/accept",
    { method: "POST", json: input },
    fetcher,
  );
}
