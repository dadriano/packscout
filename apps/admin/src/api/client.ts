export interface JsonRequestInit extends RequestInit {
  json?: unknown;
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ErrorPayload {
  error?: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

type AuthRequiredListener = () => void;

const authRequiredListeners = new Set<AuthRequiredListener>();
let csrfToken: string | null = null;

const runtimeEnv = (
  import.meta as unknown as { env?: { VITE_API_BASE?: string } }
).env;
const configuredBase =
  typeof runtimeEnv?.VITE_API_BASE === "string"
    ? runtimeEnv.VITE_API_BASE.replace(/\/$/, "")
    : undefined;
const apiBase = configuredBase || "/api";

export class AdminApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function setAdminCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function subscribeToAuthRequired(
  listener: AuthRequiredListener,
): () => void {
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

function isMutation(method: string | undefined): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(
    (method ?? "GET").toUpperCase(),
  );
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return response.json().catch(() => null);
}

export async function requestJson<T>(
  path: string,
  options: JsonRequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<T> {
  const { json, ...init } = options;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (json !== undefined) headers.set("Content-Type", "application/json");
  if (csrfToken && isMutation(init.method) && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetcher(`${apiBase}${path}`, {
    ...init,
    headers,
    credentials: "include",
    body: json === undefined ? init.body : JSON.stringify(json),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    const errorPayload = (payload ?? {}) as ErrorPayload;
    if (
      response.status === 401 &&
      errorPayload.code === "AUTH_REQUIRED" &&
      path !== "/auth/session" &&
      path !== "/auth/login"
    ) {
      for (const listener of authRequiredListeners) listener();
    }
    throw new AdminApiError(
      errorPayload.error || `Admin request failed with status ${response.status}.`,
      response.status,
      errorPayload.code,
      errorPayload.details,
      errorPayload.requestId,
    );
  }

  if (response.status === 204) return undefined as T;
  if (payload === null) {
    throw new AdminApiError(
      "The admin service returned an invalid JSON response.",
      response.status,
      "INVALID_RESPONSE",
    );
  }
  return payload as T;
}
