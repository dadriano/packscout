/**
 * The panel's browser API client. Every request carries the custom header the
 * server's origin guard requires: a cross-origin page cannot set it without a
 * preflight, and the panel never answers a preflight with CORS approval.
 */

export const PANEL_REQUEST_HEADER = "x-packscout-ops-panel";
export const PANEL_REQUEST_HEADER_VALUE = "1";

export class PanelRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "PanelRequestError";
    this.status = status;
    this.code = code;
  }
}

export async function panelFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE,
      ...init.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: string; code?: string }
    | null;

  if (!response.ok) {
    throw new PanelRequestError(
      payload?.error ?? "The operations panel could not complete that request.",
      response.status,
      payload?.code ?? "ops_panel_request_failed",
    );
  }
  return payload as T;
}
