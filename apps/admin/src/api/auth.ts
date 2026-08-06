import type {
  AuthSessionResponse,
  LoginRequest,
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
