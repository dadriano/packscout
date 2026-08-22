import { isLoopbackHostHeader, isLoopbackOrigin } from "./loopback.ts";

/**
 * The panel's structural access model. It is not account-based: the panel works
 * precisely when product and admin authentication are broken, so its guarantees
 * come from where the request can physically originate.
 *
 * Layers, in order:
 *  1. loopback bind (server/index.ts) — nothing off this machine connects;
 *  2. loopback `Origin` — a page on any other origin is refused outright;
 *  3. loopback `Host` on sensitive reads and privileged actions — defeats DNS
 *     rebinding, where a hostile name resolves to 127.0.0.1;
 *  4. a custom request header on privileged actions — a cross-origin page
 *     cannot set it without a preflight, and the panel never answers preflight
 *     with CORS approval, so the request never leaves the browser.
 *
 * Guard membership is declared here as data, not scattered through routes, so
 * admin-tools/011 through admin-tools/015 inherit it by mounting under the
 * declared prefixes rather than reimplementing checks.
 */

export const PANEL_REQUEST_HEADER = "x-packscout-ops-panel";
export const PANEL_REQUEST_HEADER_VALUE = "1";

/**
 * Sensitive reads: all log-content reads (tails, initial windows, history, deep
 * search, raw downloads) and all database-status reads, plus the panel's own
 * privileged-activity view. Declared as path prefixes so later surfaces join by
 * mounting inside them.
 */
export const SENSITIVE_READ_PATH_PREFIXES = [
  "/api/logs",
  "/api/database",
  "/api/activity",
] as const;

/**
 * Raw log-file downloads are privileged and audited even though they are reads.
 */
export const RAW_DOWNLOAD_PATH_PREFIXES = ["/api/logs/download"] as const;

/**
 * Event-stream endpoints. The browser's EventSource client cannot attach
 * request headers, so these relax the custom-header requirement — and only
 * that. Every loopback check still applies.
 */
export const EVENT_STREAM_PATH_SUFFIX = "/stream";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type PanelRejectionReason =
  | "non_loopback_origin"
  | "non_loopback_host"
  | "missing_panel_header";

export interface PanelRequestDescriptor {
  method: string;
  path: string;
  host?: string;
  origin?: string;
  panelHeader?: string;
}

export interface PanelRequestClassification {
  /** Requires a loopback `Host` header. */
  sensitiveRead: boolean;
  /** Requires the custom header and lands in the audit trail. */
  privileged: boolean;
  /** May omit the custom header because EventSource cannot send it. */
  eventStream: boolean;
  /** Stable identifier used in audit entries. */
  action: string;
}

export interface PanelAccessAllowed {
  allowed: true;
  classification: PanelRequestClassification;
}

export interface PanelAccessRejected {
  allowed: false;
  classification: PanelRequestClassification;
  reason: PanelRejectionReason;
  status: 403;
  code: string;
  message: string;
}

export type PanelAccessDecision = PanelAccessAllowed | PanelAccessRejected;

const REJECTIONS: Record<
  PanelRejectionReason,
  { code: string; message: string }
> = {
  non_loopback_origin: {
    code: "ops_panel_non_loopback_origin",
    message: "The operations panel accepts requests from loopback origins only.",
  },
  non_loopback_host: {
    code: "ops_panel_non_loopback_host",
    message: "The operations panel accepts loopback host names only.",
  },
  missing_panel_header: {
    code: "ops_panel_missing_request_header",
    message: `Privileged panel requests must send the ${PANEL_REQUEST_HEADER} request header.`,
  },
};

export function normalizeRequestPath(path: string): string {
  const withoutQuery = path.split(/[?#]/u, 1)[0] ?? "";
  const trimmed = withoutQuery.replace(/\/+$/u, "");
  return trimmed.length === 0 ? "/" : trimmed.toLowerCase();
}

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export function classifyPanelRequest(
  descriptor: Pick<PanelRequestDescriptor, "method" | "path">,
): PanelRequestClassification {
  const method = descriptor.method.toUpperCase();
  const path = normalizeRequestPath(descriptor.path);
  const mutating = MUTATING_METHODS.has(method);
  const rawDownload = matchesPrefix(path, RAW_DOWNLOAD_PATH_PREFIXES);
  const privileged = mutating || rawDownload;

  return {
    sensitiveRead: matchesPrefix(path, SENSITIVE_READ_PATH_PREFIXES),
    privileged,
    // A raw download is privileged even though it is a read, so it never earns
    // the EventSource exemption — otherwise a download path ending in `/stream`
    // would skip the custom-header check, and a cross-origin GET that sends no
    // `Origin` (an image or script tag) would clear every remaining layer.
    eventStream:
      !mutating &&
      !rawDownload &&
      (path === EVENT_STREAM_PATH_SUFFIX || path.endsWith(EVENT_STREAM_PATH_SUFFIX)),
    action: `${method} ${path}`,
  };
}

function reject(
  classification: PanelRequestClassification,
  reason: PanelRejectionReason,
): PanelAccessRejected {
  return {
    allowed: false,
    classification,
    reason,
    status: 403,
    ...REJECTIONS[reason],
  };
}

/**
 * Evaluate one request against the access model. Pure: transports translate
 * their own request objects into a descriptor and act on the decision.
 */
export function evaluatePanelAccess(
  descriptor: PanelRequestDescriptor,
): PanelAccessDecision {
  const classification = classifyPanelRequest(descriptor);

  if (descriptor.origin !== undefined && !isLoopbackOrigin(descriptor.origin)) {
    return reject(classification, "non_loopback_origin");
  }

  if (
    (classification.sensitiveRead || classification.privileged) &&
    !isLoopbackHostHeader(descriptor.host)
  ) {
    return reject(classification, "non_loopback_host");
  }

  if (
    classification.privileged &&
    !classification.eventStream &&
    descriptor.panelHeader?.trim() !== PANEL_REQUEST_HEADER_VALUE
  ) {
    return reject(classification, "missing_panel_header");
  }

  return { allowed: true, classification };
}

export function outcomeForStatus(status: number): "succeeded" | "failed" {
  return status >= 200 && status < 400 ? "succeeded" : "failed";
}
