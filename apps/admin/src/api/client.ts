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
}

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

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
  }
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

  const response = await fetcher(`${apiBase}${path}`, {
    ...init,
    headers,
    credentials: "include",
    body: json === undefined ? init.body : JSON.stringify(json),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    const errorPayload = (payload ?? {}) as ErrorPayload;
    throw new AdminApiError(
      errorPayload.error || `Admin request failed with status ${response.status}.`,
      response.status,
      errorPayload.code,
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
