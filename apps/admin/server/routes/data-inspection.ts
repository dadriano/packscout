import { Router, type RequestHandler, type Response } from "express";
import {
  comparisonScope,
  providerCatalogPlatformKeyV1Schema,
  publishedInspectableEntityKindSchema,
  publishedPublicEntityIdSchemaForKind,
  publicProviderReleaseIdV1Schema,
  publicRepackIdSchema,
} from "@packscout/contracts";
import {
  CanonicalInspectionError,
  type AuthService,
  type CanonicalInspectionService,
} from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import type { ParityRuntime } from "../parity-runtime.ts";
import {
  PublishedCatalogError,
  type PublishedCatalogReader,
} from "../published-catalog-reader.ts";
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
  /** Server-only reader for the product backend's protected inspection API. */
  readonly published?: Pick<
    PublishedCatalogReader,
    | "activeRelease"
    | "listEntities"
    | "readDocument"
    | "readChaseReconciliation"
  >;
  /** Absent until the published-catalog integration is configured. */
  readonly parity?: ParityRuntime;
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

function sendPublishedFailure(response: Response, reason: unknown): void {
  if (reason instanceof CanonicalInspectionError) {
    sendFailure(response, reason);
    return;
  }
  if (reason instanceof PublishedCatalogError) {
    response.status(reason.status).json({
      error: reason.message,
      code: reason.code,
    });
    return;
  }
  response.status(503).json({
    error: "Published data is temporarily unavailable.",
    code: "PUBLISHED_CATALOG_UNAVAILABLE",
  });
}

function invalidPublishedRequest(response: Response): void {
  sendPublishedFailure(
    response,
    new PublishedCatalogError(
      "PUBLISHED_CATALOG_REQUEST_INVALID",
      "That published catalog request was not valid.",
      400,
    ),
  );
}

function readPublishedLimit(raw: unknown): number | null {
  if (raw === undefined) return 50;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= 200 ? value : null;
}

function readPublishedCursor(raw: unknown): string | null | undefined {
  if (raw === undefined) return null;
  return typeof raw === "string" && raw.length <= 4_096 ? raw : undefined;
}

function hasOnlyQueryKeys(
  query: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(query).every((key) => allowed.has(key));
}

async function assertPublishedProviderBelongsToOrganization(input: {
  canonical: NonNullable<DataInspectionRouterDependencies["canonical"]>;
  organizationId: string;
  platformKey: string;
}): Promise<void> {
  const providers = await input.canonical.listProviders(input.organizationId);
  if (!providers.some(({ platformKey }) => platformKey === input.platformKey)) {
    throw new CanonicalInspectionError(
      "CANONICAL_PROVIDER_UNKNOWN",
      "That provider is not configured in this workspace.",
      404,
    );
  }
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
  const noStore: RequestHandler = (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  };

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
    "/published/providers/:platformKey/active-release",
    noStore,
    read,
    async (request, response) => {
      const platform = providerCatalogPlatformKeyV1Schema.safeParse(
        request.params.platformKey,
      );
      if (
        !platform.success ||
        !hasOnlyQueryKeys(request.query, new Set())
      ) {
        return invalidPublishedRequest(response);
      }
      const canonical = dependencies.canonical;
      const published = dependencies.published;
      if (!canonical) return sendFailure(response, new Error("unconfigured"));
      if (!published) {
        return sendPublishedFailure(
          response,
          new PublishedCatalogError(
            "PUBLISHED_CATALOG_UNCONFIGURED",
            "Published catalog reads are not configured on this deployment.",
            503,
          ),
        );
      }
      try {
        const actor = getAuthenticatedActor(response);
        await assertPublishedProviderBelongsToOrganization({
          canonical,
          organizationId: actor.organizationId,
          platformKey: platform.data,
        });
        response.status(200).json(await published.activeRelease(platform.data));
      } catch (reason) {
        sendPublishedFailure(response, reason);
      }
    },
  );

  router.get(
    "/published/providers/:platformKey/entities",
    noStore,
    read,
    async (request, response) => {
      const platform = providerCatalogPlatformKeyV1Schema.safeParse(
        request.params.platformKey,
      );
      const entityKind = publishedInspectableEntityKindSchema.safeParse(
        request.query.entityKind,
      );
      const expectedRelease = publicProviderReleaseIdV1Schema.safeParse(
        request.query.expectedPublicProviderReleaseId,
      );
      const numItems = readPublishedLimit(request.query.limit);
      const cursor = readPublishedCursor(request.query.cursor);
      if (
        !platform.success ||
        !entityKind.success ||
        !expectedRelease.success ||
        numItems === null ||
        cursor === undefined ||
        !hasOnlyQueryKeys(
          request.query,
          new Set([
            "entityKind",
            "expectedPublicProviderReleaseId",
            "limit",
            "cursor",
          ]),
        )
      ) {
        return invalidPublishedRequest(response);
      }
      const canonical = dependencies.canonical;
      const published = dependencies.published;
      if (!canonical) return sendFailure(response, new Error("unconfigured"));
      if (!published) {
        return sendPublishedFailure(
          response,
          new PublishedCatalogError(
            "PUBLISHED_CATALOG_UNCONFIGURED",
            "Published catalog reads are not configured on this deployment.",
            503,
          ),
        );
      }
      try {
        const actor = getAuthenticatedActor(response);
        await assertPublishedProviderBelongsToOrganization({
          canonical,
          organizationId: actor.organizationId,
          platformKey: platform.data,
        });
        response.status(200).json(
          await published.listEntities({
            platformKey: platform.data,
            expectedPublicProviderReleaseId: expectedRelease.data,
            entityKind: entityKind.data,
            numItems,
            cursor,
          }),
        );
      } catch (reason) {
        sendPublishedFailure(response, reason);
      }
    },
  );

  router.get(
    "/published/providers/:platformKey/entities/:entityKind/:publicEntityId",
    noStore,
    read,
    async (request, response) => {
      const platform = providerCatalogPlatformKeyV1Schema.safeParse(
        request.params.platformKey,
      );
      const entityKind = publishedInspectableEntityKindSchema.safeParse(
        request.params.entityKind,
      );
      const expectedRelease = publicProviderReleaseIdV1Schema.safeParse(
        request.query.expectedPublicProviderReleaseId,
      );
      if (
        !platform.success ||
        !entityKind.success ||
        !expectedRelease.success ||
        !hasOnlyQueryKeys(
          request.query,
          new Set(["expectedPublicProviderReleaseId"]),
        )
      ) {
        return invalidPublishedRequest(response);
      }
      const publicEntityId = publishedPublicEntityIdSchemaForKind(
        entityKind.data,
      ).safeParse(request.params.publicEntityId);
      if (!publicEntityId.success) return invalidPublishedRequest(response);
      const canonical = dependencies.canonical;
      const published = dependencies.published;
      if (!canonical) return sendFailure(response, new Error("unconfigured"));
      if (!published) {
        return sendPublishedFailure(
          response,
          new PublishedCatalogError(
            "PUBLISHED_CATALOG_UNCONFIGURED",
            "Published catalog reads are not configured on this deployment.",
            503,
          ),
        );
      }
      try {
        const actor = getAuthenticatedActor(response);
        await assertPublishedProviderBelongsToOrganization({
          canonical,
          organizationId: actor.organizationId,
          platformKey: platform.data,
        });
        response.status(200).json(
          await published.readDocument({
            platformKey: platform.data,
            expectedPublicProviderReleaseId: expectedRelease.data,
            entityKind: entityKind.data,
            publicEntityId: publicEntityId.data,
          }),
        );
      } catch (reason) {
        sendPublishedFailure(response, reason);
      }
    },
  );

  router.get(
    "/published/providers/:platformKey/repacks/:publicRepackId/chase-reconciliation",
    noStore,
    read,
    async (request, response) => {
      const platform = providerCatalogPlatformKeyV1Schema.safeParse(
        request.params.platformKey,
      );
      const publicRepackId = publicRepackIdSchema.safeParse(
        request.params.publicRepackId,
      );
      const expectedRelease = publicProviderReleaseIdV1Schema.safeParse(
        request.query.expectedPublicProviderReleaseId,
      );
      if (
        !platform.success ||
        !publicRepackId.success ||
        !expectedRelease.success ||
        !hasOnlyQueryKeys(
          request.query,
          new Set(["expectedPublicProviderReleaseId"]),
        )
      ) {
        return invalidPublishedRequest(response);
      }
      const canonical = dependencies.canonical;
      const published = dependencies.published;
      if (!canonical) return sendFailure(response, new Error("unconfigured"));
      if (!published) {
        return sendPublishedFailure(
          response,
          new PublishedCatalogError(
            "PUBLISHED_CATALOG_UNCONFIGURED",
            "Published catalog reads are not configured on this deployment.",
            503,
          ),
        );
      }
      try {
        const actor = getAuthenticatedActor(response);
        await assertPublishedProviderBelongsToOrganization({
          canonical,
          organizationId: actor.organizationId,
          platformKey: platform.data,
        });
        response.status(200).json(
          await published.readChaseReconciliation({
            platformKey: platform.data,
            expectedPublicProviderReleaseId: expectedRelease.data,
            publicRepackId: publicRepackId.data,
          }),
        );
      } catch (reason) {
        sendPublishedFailure(response, reason);
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
            page: readLimit(request.query.page),
            limit: readLimit(request.query.limit),
            direction: readText(request.query.direction),
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

  /**
   * Every provider's verdict in one read. Cheap by construction: fingerprints,
   * checkpoints, and counts only — no record on either side is touched.
   */
  router.get("/compare/summary", read, async (_request, response) => {
    const parity = dependencies.parity;
    if (!parity) return sendFailure(response, new Error("unconfigured"));
    try {
      const actor = getAuthenticatedActor(response);
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json(await parity.summarize(actor.organizationId));
    } catch (reason) {
      sendFailure(response, reason);
    }
  });

  router.get(
    "/compare/providers/:platformKey",
    read,
    async (request, response) => {
      const parity = dependencies.parity;
      if (!parity) return sendFailure(response, new Error("unconfigured"));
      try {
        const actor = getAuthenticatedActor(response);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json(
          await parity.detail({
            organizationId: actor.organizationId,
            platformKey: request.params.platformKey,
          }),
        );
      } catch (reason) {
        sendFailure(response, reason);
      }
    },
  );

  return router;
}
