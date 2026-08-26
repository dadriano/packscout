import type { ProductUserDirectoryConfig } from "./runtime-config.ts";

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

/** What the active manifest serves for one platform, or why it serves nothing. */
export type PublishedActiveRelease =
  | { readonly status: "no_active_manifest" }
  | {
      readonly status: "platform_not_referenced";
      readonly manifestPublicReleaseId: string;
    }
  | {
      readonly status: "release_missing";
      readonly manifestPublicReleaseId: string;
      readonly publicProviderReleaseId: string;
    }
  | {
      readonly status: "active";
      readonly manifestPublicReleaseId: string;
      readonly referenceFingerprint: string;
      readonly release: PublishedReleaseFacts;
    };

export interface PublishedReleaseFacts {
  readonly publicProviderReleaseId: string;
  readonly platformKey: string;
  readonly lifecycle: "staging" | "complete" | "failed" | "retired";
  readonly dataAsOf: string;
  readonly providerReleaseFingerprint: string;
  readonly contentHash: string;
  readonly entityHashes: Record<string, string>;
  readonly counts: Record<string, number>;
  readonly batchCount: number;
  readonly batchChainHash: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly completionOperationId: string | null;
}

export type PublishedEntityPage =
  | { readonly status: "release_unknown" }
  | {
      readonly status: "ok";
      readonly items: readonly {
        readonly publicEntityId: string;
        readonly detail: unknown;
      }[];
      readonly isDone: boolean;
      readonly continueCursor: string;
    };

export type PublishedIdPage =
  | { readonly status: "release_unknown" }
  | {
      readonly status: "ok";
      readonly publicEntityIds: readonly string[];
      readonly isDone: boolean;
      readonly continueCursor: string;
    };

export type PublishedDocument =
  | { readonly status: "release_unknown" }
  | { readonly status: "not_present" }
  | {
      readonly status: "ok";
      readonly publicEntityId: string;
      readonly detail: unknown;
    };

export type PublishedChaseReconciliation =
  | { readonly status: "release_unknown" }
  | { readonly status: "not_present" }
  | {
      readonly status: "ok";
      readonly publicRepackId: string;
      readonly expectedChaseCount: number;
      readonly acceptedChaseCount: number;
      readonly complete: boolean;
    };

export interface PublishedCatalogReader {
  activeRelease(platformKey: string): Promise<PublishedActiveRelease>;
  listEntities(input: {
    publicProviderReleaseId: string;
    entityKind: string;
    numItems: number;
    cursor: string | null;
  }): Promise<PublishedEntityPage>;
  listEntityIds(input: {
    publicProviderReleaseId: string;
    entityKind: string;
    numItems: number;
    cursor: string | null;
  }): Promise<PublishedIdPage>;
  readDocument(input: {
    publicProviderReleaseId: string;
    entityKind: string;
    publicEntityId: string;
  }): Promise<PublishedDocument>;
  readChaseReconciliation(input: {
    publicProviderReleaseId: string;
    publicRepackId: string;
  }): Promise<PublishedChaseReconciliation>;
}

export function createPublishedCatalogReader(input: {
  config: ProductUserDirectoryConfig | null;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}): PublishedCatalogReader {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    if (!input.config) {
      throw new PublishedCatalogError(
        "PUBLISHED_CATALOG_UNCONFIGURED",
        "Published catalog reads are not configured on this deployment.",
        503,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    } finally {
      clearTimeout(timer);
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
      return (await response.json()) as T;
    } catch {
      throw new PublishedCatalogError(
        "PUBLISHED_CATALOG_UNAVAILABLE",
        "The published catalog returned an unreadable response.",
        503,
      );
    }
  };

  return {
    activeRelease: (platformKey) =>
      call<PublishedActiveRelease>(ACTIVE_RELEASE_PATH, { platformKey }),
    listEntities: ({ publicProviderReleaseId, entityKind, numItems, cursor }) =>
      call<PublishedEntityPage>(ENTITIES_PATH, {
        publicProviderReleaseId,
        entityKind,
        paginationOpts: { numItems, cursor },
      }),
    listEntityIds: ({ publicProviderReleaseId, entityKind, numItems, cursor }) =>
      call<PublishedIdPage>(ENTITY_IDS_PATH, {
        publicProviderReleaseId,
        entityKind,
        paginationOpts: { numItems, cursor },
      }),
    readDocument: (request) => call<PublishedDocument>(DOCUMENT_PATH, request),
    readChaseReconciliation: (request) =>
      call<PublishedChaseReconciliation>(CHASE_RECONCILIATION_PATH, request),
  };
}
