import { Router, type Response } from "express";
import { comparisonScope } from "@packscout/contracts";
import {
  CanonicalInspectionError,
  type AuthService,
  type CanonicalInspectionService,
} from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

/**
 * The admin's read-only data-inspection surface.
 *
 * Every route here authenticates first and then requires `data_inspection:view`,
 * a permission held separately from provider configuration access so it can be
 * withdrawn on its own. Nothing on this router mutates anything: the surfaces it
 * backs read canonical records, read their published counterparts, and compare
 * the two. Remediation stays with the provider, import-run, and background-work
 * routers that already own it.
 */

export interface DataInspectionRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly cookiePolicy: SessionCookiePolicy;
  /** Absent until canonical reads are configured; the routes then report so. */
  readonly canonical?: Pick<
    CanonicalInspectionService,
    "listProviders" | "summarizeProvider" | "listEntities" | "readEntity"
  >;
}

/**
 * One place where a failure becomes a response. Anything that is not already a
 * classified inspection failure collapses to the unavailable code, so a driver
 * message, a query fragment, or a stack never reaches a caller.
 */
function sendFailure(response: Response, reason: unknown): void {
  if (reason instanceof CanonicalInspectionError) {
    response.status(reason.status).json({
      error: reason.message,
      code: reason.code,
    });
    return;
  }
  response.status(503).json({
    error: "Canonical data is temporarily unavailable.",
    code: "CANONICAL_STORE_UNAVAILABLE",
  });
}

/** A single positive integer from a query string, or undefined. */
function readLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function readText(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** The permission every data-inspection route requires. */
export const DATA_INSPECTION_PERMISSION = "data_inspection:view" as const;

export function createDataInspectionRouter(
  dependencies: DataInspectionRouterDependencies,
) {
  const router = Router();
  const read = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { permission: DATA_INSPECTION_PERMISSION },
  );

  /**
   * Which canonical kinds have a published counterpart and which are
   * pipeline-only. Served from the shared contract rather than restated per
   * surface, so the published browser and the comparison view cannot drift into
   * disagreeing about what "missing" means.
   */
  router.get("/scope", read, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(comparisonScope());
  });

  /**
   * The provider roster. Every canonical and published surface names providers
   * from this one list, so the Data section cannot disagree with itself about
   * which providers exist.
   */
  router.get("/canonical/providers", read, async (_request, response) => {
    const canonical = dependencies.canonical;
    if (!canonical) return sendFailure(response, new Error("unconfigured"));
    try {
      const actor = getAuthenticatedActor(response);
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        providers: await canonical.listProviders(actor.organizationId),
      });
    } catch (reason) {
      sendFailure(response, reason);
    }
  });

  router.get(
    "/canonical/providers/:platformKey/summary",
    read,
    async (request, response) => {
      const canonical = dependencies.canonical;
      if (!canonical) return sendFailure(response, new Error("unconfigured"));
      try {
        const actor = getAuthenticatedActor(response);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json(
          await canonical.summarizeProvider({
            organizationId: actor.organizationId,
            platformKey: request.params.platformKey,
          }),
        );
      } catch (reason) {
        sendFailure(response, reason);
      }
    },
  );

  router.get(
    "/canonical/providers/:platformKey/entities",
    read,
    async (request, response) => {
      const canonical = dependencies.canonical;
      if (!canonical) return sendFailure(response, new Error("unconfigured"));
      try {
        const actor = getAuthenticatedActor(response);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json(
          await canonical.listEntities({
            organizationId: actor.organizationId,
            platformKey: request.params.platformKey,
            recordKind: String(request.query.recordKind ?? ""),
            externalId: readText(request.query.externalId),
            search: readText(request.query.search),
            cursor: readText(request.query.cursor),
            limit: readLimit(request.query.limit),
          }),
        );
      } catch (reason) {
        sendFailure(response, reason);
      }
    },
  );

  router.get(
    "/canonical/providers/:platformKey/entities/:recordKind/:externalId",
    read,
    async (request, response) => {
      const canonical = dependencies.canonical;
      if (!canonical) return sendFailure(response, new Error("unconfigured"));
      try {
        const actor = getAuthenticatedActor(response);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json(
          await canonical.readEntity({
            organizationId: actor.organizationId,
            platformKey: request.params.platformKey,
            recordKind: request.params.recordKind,
            externalId: request.params.externalId,
          }),
        );
      } catch (reason) {
        sendFailure(response, reason);
      }
    },
  );

  return router;
}
