import {
  publishedActiveReleaseSchema,
  publishedProviderChaseReconciliationSchema,
  publishedProviderDocumentSchemaForKind,
  publishedProviderEntityPageSchemaForKind,
  publishedProviderIdPageSchemaForKind,
  type PublishedActiveRelease,
  type PublishedInspectableEntityKind,
  type PublishedProviderChaseReconciliation,
  type PublishedProviderDocument,
  type PublishedProviderEntityPage,
  type PublishedProviderIdPage,
} from "@packscout/contracts";
import type { ProductUserDirectoryConfig } from "./runtime-config.ts";

export type {
  PublishedActiveRelease,
  PublishedReleaseFacts,
} from "@packscout/contracts";

/**
 * The admin's server-to-server reader for published provider catalog data.
 *
 * The product backend's inspection surface is POST-only and authenticated with
 * a deployment secret. That secret is read from server configuration, held here,
 * and sent as a request header — it never reaches a browser bundle, a response
 * body, or a log line. Upstream failures collapse into a small set of stable
 * codes so no upstream body ever propagates to an operator.
 *
 * Reuses the same integration configuration as the product-user directory:
 * both are the admin talking to the same backend's admin surface with the same
 * secret, and a second configuration would be a second thing to rotate.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

const ACTIVE_RELEASE_PATH = "/admin/provider-catalog/active-release";
const ENTITIES_PATH = "/admin/provider-catalog/entities";
const ENTITY_IDS_PATH = "/admin/provider-catalog/entity-ids";
const DOCUMENT_PATH = "/admin/provider-catalog/document";
const CHASE_RECONCILIATION_PATH =
  "/admin/provider-catalog/chase-reconciliation";

export type PublishedCatalogErrorCode =
  | "PUBLISHED_CATALOG_UNCONFIGURED"
  | "PUBLISHED_CATALOG_UNAUTHORIZED"
  | "PUBLISHED_CATALOG_REQUEST_INVALID"
  | "PUBLISHED_CATALOG_UNAVAILABLE";

export class PublishedCatalogError extends Error {
  constructor(
    readonly code: PublishedCatalogErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublishedCatalogError";
  }
}

/** Compatibility names for the server-only integration boundary. */
export type PublishedEntityPage = PublishedProviderEntityPage;
export type PublishedIdPage = PublishedProviderIdPage;
export type PublishedDocument = PublishedProviderDocument;
export type PublishedChaseReconciliation =
  PublishedProviderChaseReconciliation;

export interface PublishedCatalogReader {
  activeRelease(platformKey: string): Promise<PublishedActiveRelease>;
  listEntities(input: {
    platformKey: string;
    expectedPublicProviderReleaseId: string;
    entityKind: PublishedInspectableEntityKind;
    numItems: number;
    cursor: string | null;
  }): Promise<PublishedEntityPage>;
  listEntityIds(input: {
    publicProviderReleaseId: string;
    entityKind: PublishedInspectableEntityKind;
    numItems: number;
    cursor: string | null;
  }): Promise<PublishedIdPage>;
  readDocument(input: {
    platformKey: string;
    expectedPublicProviderReleaseId: string;
    entityKind: PublishedInspectableEntityKind;
    publicEntityId: string;
  }): Promise<PublishedDocument>;
  readChaseReconciliation(input: {
    platformKey: string;
    expectedPublicProviderReleaseId: string;
    publicRepackId: string;
  }): Promise<PublishedChaseReconciliation>;
}

export function createPublishedCatalogReader(input: {
  config: ProductUserDirectoryConfig | null;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}): PublishedCatalogReader {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = async <T>(
    path: string,
    body: unknown,
    schema: {
      safeParse(value: unknown):
        | { success: true; data: T }
        | { success: false };
    },
  ): Promise<T> => {
    if (!input.config) {
      throw new PublishedCatalogError(
        "PUBLISHED_CATALOG_UNCONFIGURED",
        "Published catalog reads are not configured on this deployment.",
        503,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await (input.fetchImplementation ?? fetch)(
          new URL(path, input.config.baseUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${input.config.token}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
      } catch {
        // A transport failure carries a host and sometimes a port. Neither
        // belongs in an operator's browser, so nothing from it is forwarded.
        throw new PublishedCatalogError(
          "PUBLISHED_CATALOG_UNAVAILABLE",
          "The published catalog is temporarily unreachable.",
          503,
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new PublishedCatalogError(
          "PUBLISHED_CATALOG_UNAUTHORIZED",
          "The published catalog integration is not authorized.",
          502,
        );
      }
      if (response.status === 400) {
        throw new PublishedCatalogError(
          "PUBLISHED_CATALOG_REQUEST_INVALID",
          "That published catalog request was not valid.",
          400,
        );
      }
      if (!response.ok) {
        throw new PublishedCatalogError(
          "PUBLISHED_CATALOG_UNAVAILABLE",
          "The published catalog is temporarily unavailable.",
          503,
        );
      }
      try {
        const parsed = schema.safeParse(await response.json());
        if (parsed.success) return parsed.data;
      } catch {
        // Fall through to the same stable refusal as a schema mismatch. Neither
        // raw JSON nor validator detail may cross this server boundary.
      }
      throw new PublishedCatalogError(
        "PUBLISHED_CATALOG_UNAVAILABLE",
        "The published catalog returned an unreadable response.",
        503,
      );
    } finally {
      // Fetch resolves when response headers arrive. Keep the deadline armed
      // until status handling and body consumption are both complete so a
      // stalled upstream body cannot hold the admin request open forever.
      clearTimeout(timer);
    }
  };

  return {
    activeRelease: (platformKey) =>
      call(ACTIVE_RELEASE_PATH, { platformKey }, publishedActiveReleaseSchema),
    listEntities: ({
      platformKey,
      expectedPublicProviderReleaseId,
      entityKind,
      numItems,
      cursor,
    }) =>
      call(
        ENTITIES_PATH,
        {
          platformKey,
          expectedPublicProviderReleaseId,
          entityKind,
          paginationOpts: { numItems, cursor },
        },
        publishedProviderEntityPageSchemaForKind(entityKind),
      ),
    listEntityIds: ({ publicProviderReleaseId, entityKind, numItems, cursor }) =>
      call(
        ENTITY_IDS_PATH,
        {
          publicProviderReleaseId,
          entityKind,
          paginationOpts: { numItems, cursor },
        },
        publishedProviderIdPageSchemaForKind(entityKind),
      ),
    readDocument: (request) =>
      call(
        DOCUMENT_PATH,
        request,
        publishedProviderDocumentSchemaForKind(request.entityKind),
      ),
    readChaseReconciliation: (request) =>
      call(
        CHASE_RECONCILIATION_PATH,
        request,
        publishedProviderChaseReconciliationSchema,
      ),
  };
}
