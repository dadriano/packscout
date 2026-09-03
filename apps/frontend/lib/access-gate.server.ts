import { cache } from "react";
import { cookies } from "next/headers";
import type { Metadata, MetadataRoute } from "next";
import { fetchQuery } from "convex/nextjs";
import { ConvexError } from "convex/values";
import { api } from "../../../convex/_generated/api";
import {
  ACCESS_IDENTITY_COOKIE,
  identityTokenShapeValid,
} from "./identity-cookie";
import { LANDING_METADATA } from "./landing-content";
import { readPublicConvexOrigin } from "./security-policy.server";

/**
 * The server-side closed-beta gate (closed-beta-access/007).
 *
 * Every product surface is server-rendered with catalog data embedded, so the
 * admission decision has to happen here, before render: the server reads the
 * visitor's identity cookie, verifies it against the product backend, and
 * resolves one total routing decision that every page, metadata read, and
 * data route consumes. A browser-side check is deliberately absent — by the
 * time client code could redirect, the payload would already have shipped.
 *
 * The decision is re-resolved from the backend on every request (the
 * reference model's standing rule: a cached token can be stale), so a revoked
 * or declined account loses the product on its next navigation. The only
 * cross-request reuse is the anonymous beta on/off switch, cached for
 * `GATE_STATUS_TTL_MS` per server process. Everything unknown fails closed:
 * an unreachable backend, an unreadable state, or an unconfigured deployment
 * is never admitted.
 */

export type AccessHoldReason = "awaiting_review" | "declined" | "suspended";

export type VisitorAccessDecision =
  /** The beta switch is off — the product is fully public, exactly as before. */
  | Readonly<{ outcome: "public" }>
  /** Beta on; the verified identity is approved and not suspended. */
  | Readonly<{ outcome: "admitted" }>
  /** Beta on; no identity, or one the backend refused to recognize. */
  | Readonly<{ outcome: "signed_out" }>
  /** Beta on; a verified identity the beta is holding at the door. */
  | Readonly<{ outcome: "held"; reason: AccessHoldReason }>
  /** The decision could not be resolved. Fail closed, offer retry. */
  | Readonly<{ outcome: "undetermined" }>;

const PUBLIC_DECISION: VisitorAccessDecision = Object.freeze({
  outcome: "public",
});
const ADMITTED_DECISION: VisitorAccessDecision = Object.freeze({
  outcome: "admitted",
});
const SIGNED_OUT_DECISION: VisitorAccessDecision = Object.freeze({
  outcome: "signed_out",
});
const UNDETERMINED_DECISION: VisitorAccessDecision = Object.freeze({
  outcome: "undetermined",
});

/**
 * How long one server process may reuse the anonymous "is the beta on?"
 * answer. This is the documented freshness bound on the deployment switch: a
 * flip in either direction reaches every instance within this window, while
 * per-identity decisions are never cached at all. Failures are not cached —
 * an unknown switch is re-asked on the next request.
 */
export const GATE_STATUS_TTL_MS = 30_000;

/**
 * The ceiling on each backend resolution. A hung backend becomes a
 * fail-closed undetermined outcome instead of a hung page.
 */
export const GATE_RESOLUTION_TIMEOUT_MS = 5_000;

type EffectiveAccessResult = Readonly<{
  admitted: boolean;
  reason:
    | "approved"
    | "awaiting_review"
    | "declined"
    | "suspended"
    | "undetermined";
}>;

export type AccessGateDependencies = Readonly<{
  /** The product backend origin, or null when this deployment has none. */
  convexUrl: () => string | null;
  /** The raw identity-cookie value for this request, or null. */
  readIdentityToken: () => Promise<string | null>;
  /** The anonymous gate-status read (closed-beta-access/001). */
  fetchGateStatus: (url: string) => Promise<{ closedBetaActive: boolean }>;
  /** The authenticated effective-access self-read (closed-beta-access/001). */
  fetchMyAccess: (url: string, token: string) => Promise<EffectiveAccessResult>;
  now?: () => number;
  gateStatusTtlMs?: number;
  resolutionTimeoutMs?: number;
}>;

export type VisitorAccessGate = Readonly<{
  /** The total routing decision for the current request. */
  resolve: () => Promise<VisitorAccessDecision>;
  /** The cached beta switch alone, for indexing surfaces. Null when unknown. */
  readGateStatus: () => Promise<boolean | null>;
}>;

function heldReason(
  reason: EffectiveAccessResult["reason"],
): AccessHoldReason | null {
  return reason === "awaiting_review" ||
      reason === "declined" ||
      reason === "suspended"
    ? reason
    : null;
}

/**
 * The backend's way of saying "this call carried no usable identity": the
 * product functions refuse with this code, and the platform itself rejects
 * invalid or expired tokens before the function runs. Both mean signed out —
 * a refused credential is not an outage. Anything else stays undetermined.
 */
function isIdentityRefusal(error: unknown): boolean {
  if (error instanceof ConvexError) {
    const code = (error.data as { code?: unknown } | null)?.code;
    return code === "AUTH_REQUIRED";
  }
  return (
    error instanceof Error &&
    /\b(?:unauthenticated|authentication failed|401)\b/i.test(error.message)
  );
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Access resolution timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a gate around injectable reads so the resolution logic is testable
 * without a backend. One instance owns one gate-status cache.
 */
export function createVisitorAccessGate(
  dependencies: AccessGateDependencies,
): VisitorAccessGate {
  const now = dependencies.now ?? Date.now;
  const ttlMs = dependencies.gateStatusTtlMs ?? GATE_STATUS_TTL_MS;
  const timeoutMs = dependencies.resolutionTimeoutMs ??
    GATE_RESOLUTION_TIMEOUT_MS;
  let cachedGateStatus:
    | Readonly<{ closedBetaActive: boolean; expiresAt: number }>
    | null = null;

  async function readGateStatus(): Promise<boolean | null> {
    const url = dependencies.convexUrl();
    if (url === null) return null;
    if (cachedGateStatus !== null && cachedGateStatus.expiresAt > now()) {
      return cachedGateStatus.closedBetaActive;
    }
    try {
      const status = await withTimeout(
        dependencies.fetchGateStatus(url),
        timeoutMs,
      );
      if (typeof status?.closedBetaActive !== "boolean") return null;
      cachedGateStatus = {
        closedBetaActive: status.closedBetaActive,
        expiresAt: now() + ttlMs,
      };
      return status.closedBetaActive;
    } catch {
      return null;
    }
  }

  async function resolve(): Promise<VisitorAccessDecision> {
    const url = dependencies.convexUrl();
    if (url === null) return UNDETERMINED_DECISION;

    const closedBetaActive = await readGateStatus();
    if (closedBetaActive === null) return UNDETERMINED_DECISION;
    if (!closedBetaActive) return PUBLIC_DECISION;

    let token: string | null;
    try {
      token = await dependencies.readIdentityToken();
    } catch {
      token = null;
    }
    if (token === null || !identityTokenShapeValid(token)) {
      // No credential, or one that is not even token-shaped. A garbage
      // cookie is not evidence of a session, so it reads as signed out —
      // which lands on the public landing page, never the product.
      return SIGNED_OUT_DECISION;
    }

    try {
      const access = await withTimeout(
        dependencies.fetchMyAccess(url, token),
        timeoutMs,
      );
      if (access?.admitted === true) return ADMITTED_DECISION;
      const reason = heldReason(access?.reason ?? "undetermined");
      if (reason !== null) return Object.freeze({ outcome: "held", reason });
      return UNDETERMINED_DECISION;
    } catch (error) {
      return isIdentityRefusal(error)
        ? SIGNED_OUT_DECISION
        : UNDETERMINED_DECISION;
    }
  }

  return { resolve, readGateStatus };
}

function defaultDependencies(): AccessGateDependencies {
  return {
    convexUrl: () => {
      try {
        return readPublicConvexOrigin();
      } catch {
        return null;
      }
    },
    readIdentityToken: async () =>
      (await cookies()).get(ACCESS_IDENTITY_COOKIE)?.value ?? null,
    fetchGateStatus: (url) =>
      fetchQuery(api.productUserAccess.getGateStatus, {}, { url }),
    fetchMyAccess: (url, token) =>
      fetchQuery(api.productUserAccess.getMyAccess, {}, { url, token }),
  };
}

const defaultGate = createVisitorAccessGate(defaultDependencies());

/**
 * The per-request resolution for route handlers, which have no render-scoped
 * memoization and make exactly one call each.
 */
export const resolveVisitorAccessForRequest = defaultGate.resolve;

/**
 * The per-request resolution for server components and metadata. React's
 * cache() dedupes it across the layout, the page, and generateMetadata, so a
 * rendered page costs at most one identity resolution — plus, at most once
 * per `GATE_STATUS_TTL_MS` per process, one gate-status refresh.
 */
export const resolveVisitorAccess = cache(defaultGate.resolve);

/** The cached beta switch for indexing surfaces (robots). Null when unknown. */
export const readGateStatusForRequest = defaultGate.readGateStatus;

// --- Routing outcomes -------------------------------------------------------

export type RootRouteOutcome =
  | Readonly<{ kind: "product" }>
  | Readonly<{ kind: "landing" }>
  | Readonly<{ kind: "redirect"; destination: "/access" }>;

/**
 * What the root serves. It stays dual-purpose: the product for admitted
 * visitors and for everyone once the switch is off, the landing surface for
 * strangers, and a hand-off to the holding surface for signed-in visitors the
 * beta is holding — including the fail-closed undetermined state, which the
 * holding surface renders as a retry rather than a decision.
 */
export function resolveRootRoute(
  decision: VisitorAccessDecision,
): RootRouteOutcome {
  switch (decision.outcome) {
    case "public":
    case "admitted":
      return { kind: "product" };
    case "signed_out":
      return { kind: "landing" };
    case "held":
    case "undetermined":
      return { kind: "redirect", destination: "/access" };
  }
}

export type GatedRouteOutcome =
  | Readonly<{ kind: "render" }>
  | Readonly<{ kind: "redirect"; destination: "/" | "/access" }>;

/**
 * What every gated route does before it reads anything: render for admitted
 * (or fully public) visitors, send strangers to the landing root, and send
 * held or unresolved sessions to the holding surface. Redirect targets never
 * point back at a gated route, so no decision can loop.
 */
export function resolveGatedRoute(
  decision: VisitorAccessDecision,
): GatedRouteOutcome {
  switch (decision.outcome) {
    case "public":
    case "admitted":
      return { kind: "render" };
    case "signed_out":
      return { kind: "redirect", destination: "/" };
    case "held":
    case "undetermined":
      return { kind: "redirect", destination: "/access" };
  }
}

export type AccessRouteOutcome =
  | Readonly<{ kind: "hold"; reason: AccessHoldReason | "undetermined" }>
  | Readonly<{ kind: "redirect"; destination: "/" }>;

/**
 * What the holding surface itself does. It re-resolves rather than trusting a
 * forgeable query parameter, renders the held reasons and the fail-closed
 * undetermined retry, and sends everyone else back to the root — which
 * renders for them rather than redirecting here again, so the pair cannot
 * cycle on any single decision.
 */
export function resolveAccessRoute(
  decision: VisitorAccessDecision,
): AccessRouteOutcome {
  switch (decision.outcome) {
    case "held":
      return { kind: "hold", reason: decision.reason };
    case "undetermined":
      return { kind: "hold", reason: "undetermined" };
    case "public":
    case "admitted":
    case "signed_out":
      return { kind: "redirect", destination: "/" };
  }
}

/** The shell chrome a request starts with: product chrome only for visitors the product renders for. */
export function shellSurfaceForDecision(
  decision: VisitorAccessDecision,
): "product" | "gateway" {
  return decision.outcome === "public" || decision.outcome === "admitted"
    ? "product"
    : "gateway";
}

// --- Indexing ---------------------------------------------------------------

/**
 * Robots meta for a gated surface: excluded from indexing whenever the beta
 * is on or the answer is unknown, and untouched — exactly today's metadata —
 * once the switch is off.
 */
export function gatedSurfaceRobots(
  decision: VisitorAccessDecision,
): Metadata["robots"] {
  return decision.outcome === "public"
    ? undefined
    : { index: false, follow: false };
}

/**
 * The root's metadata follows what the root serves: the layout's unchanged
 * defaults while the product is public, the indexable landing metadata for
 * visitors who get the landing surface, and a noindex product page for
 * admitted visitors while the beta is on (a crawler is never admitted; this
 * is belt and braces).
 */
export function rootRouteMetadata(decision: VisitorAccessDecision): Metadata {
  switch (decision.outcome) {
    case "public":
      return {};
    case "admitted":
      return { robots: { index: false, follow: false } };
    case "signed_out":
    case "held":
    case "undetermined":
      return LANDING_METADATA;
  }
}

/**
 * Path prefixes crawlers are told to skip while the beta is on. The landing
 * root stays crawlable; the holding surface, the product surfaces, and the
 * data routes do not.
 */
export const GATED_INDEX_EXCLUSIONS: readonly string[] = Object.freeze([
  "/access",
  "/api/",
  "/learn",
  "/packs",
]);

/**
 * The robots policy for the whole site. Fail-closed: an unknown switch keeps
 * the exclusions. With the switch off there is no robots restriction at all,
 * matching the pre-beta site, which shipped none.
 */
export function robotsPolicyForGateStatus(
  closedBetaActive: boolean | null,
): MetadataRoute.Robots {
  if (closedBetaActive === false) {
    return { rules: [{ userAgent: "*", allow: "/" }] };
  }
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [...GATED_INDEX_EXCLUSIONS],
      },
    ],
  };
}

// --- Data-route guarding ----------------------------------------------------

function guardResponse(
  body: Readonly<Record<string, unknown>>,
  status: number,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/**
 * Wraps a data-serving route handler so it requires an admitted caller.
 * Refusals are fixed strings with nothing derived from the visitor — no
 * admission reason, no identity, no catalog data — and an unresolvable
 * decision refuses as temporarily unavailable rather than admitting anyone.
 * Authentication runs before the wrapped handler parses anything.
 */
export function createAccessGuardedHandler(
  resolveDecision: () => Promise<VisitorAccessDecision>,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async function accessGuardedHandler(request: Request) {
    let decision: VisitorAccessDecision;
    try {
      decision = await resolveDecision();
    } catch {
      decision = UNDETERMINED_DECISION;
    }
    if (decision.outcome === "public" || decision.outcome === "admitted") {
      return handler(request);
    }
    if (decision.outcome === "undetermined") {
      return guardResponse(
        {
          ok: false,
          code: "ACCESS_UNAVAILABLE",
          error: "Access could not be confirmed. Try again shortly.",
          retryable: true,
        },
        503,
      );
    }
    return guardResponse(
      {
        ok: false,
        code: "ACCESS_REQUIRED",
        error: "An approved beta account is required.",
        retryable: false,
      },
      401,
    );
  };
}
