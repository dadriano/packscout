import {
  CANONICAL_COUNT_BOUND,
  CANONICAL_EXTERNAL_ID_MAX_LENGTH,
  CANONICAL_PAGE_SIZE_DEFAULT,
  CANONICAL_MAX_OFFSET,
  CANONICAL_PAGE_SIZE_MAX,
  canonicalRecordKinds,
  type CanonicalEntityDetail,
  type CanonicalEntityPage,
  type CanonicalInspectionErrorCode,
  type CanonicalProviderRow,
  type CanonicalProviderSummary,
  type CanonicalRecordKind,
} from "@packscout/contracts";
import {
  redactSensitive,
  summarizeProvenance,
} from "./inspection-redaction.ts";

/**
 * Persistence boundary for the canonical inspection use case.
 *
 * The original implementation happened to use the legacy combined Prisma
 * repository directly. Keeping that concrete class in the service signature
 * made it impossible to preserve this HTTP contract while routing an
 * authorized request to a provider-local database. Both persistence models
 * now implement this read-only shape; runtime composition chooses exactly one.
 */
export interface CanonicalInspectionRepository {
  listProviders(organizationId: string): Promise<readonly {
    readonly platformKey: string;
    readonly displayName: string;
    readonly state: string;
  }[]>;
  providerExists(input: {
    readonly organizationId: string;
    readonly platformKey: string;
  }): Promise<boolean>;
  countBounded(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly bound: number;
  }): Promise<{ readonly count: number; readonly bounded: boolean }>;
  kindRecency(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly collectedExtrema: boolean;
  }): Promise<{
    readonly oldestCollectedAt: Date | null;
    readonly newestCollectedAt: Date | null;
    readonly oldestAcceptedAt: Date | null;
    readonly newestAcceptedAt: Date | null;
    readonly collectedExtremaComplete: boolean;
  }>;
  listEntities(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly externalId?: string;
    readonly externalIdPrefix?: string;
    readonly offset: number;
    readonly limit: number;
    readonly direction?: "asc" | "desc";
  }): Promise<{
    readonly items: readonly {
      readonly entityId: string;
      readonly platformKey: string;
      readonly recordKind: CanonicalRecordKind;
      readonly externalId: string;
      readonly revisionNumber: number | null;
      readonly sourceUpdatedAt: Date | null;
      readonly sourceCollectedAt: Date | null;
      readonly acceptedAt: Date | null;
    }[];
    readonly hasMore: boolean;
  }>;
  readEntity(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly externalId: string;
  }): Promise<{
    readonly entityId: string;
    readonly platformKey: string;
    readonly recordKind: CanonicalRecordKind;
    readonly externalId: string;
    readonly revisionNumber: number | null;
    readonly sourceUpdatedAt: Date | null;
    readonly sourceCollectedAt: Date | null;
    readonly acceptedAt: Date | null;
    readonly content: unknown;
    readonly contentHash: string | null;
    readonly provenance: unknown;
    readonly provenanceHash: string | null;
    readonly relationships: readonly {
      readonly relationshipKind: string;
      readonly targetPlatformKey: string;
      readonly targetRecordKind: CanonicalRecordKind;
      readonly targetExternalId: string | null;
      readonly resolved: boolean;
    }[];
  } | null>;
}

/**
 * The read side of the admin's canonical data inspection.
 *
 * This layer owns three things the repository deliberately does not: turning
 * caller input into an enumerated, bounded request; turning a store failure into
 * a stable code that carries no driver text; and sanitizing everything on the
 * way out. Presentation belongs to the admin surfaces above it.
 */

export class CanonicalInspectionError extends Error {
  constructor(
    readonly code: CanonicalInspectionErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CanonicalInspectionError";
  }
}

/** One-based page numbers; anything else is a caller error, not a silent 1. */
function assertPage(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new CanonicalInspectionError(
      "CANONICAL_PAGE_INVALID",
      "That page number is not valid.",
      400,
    );
  }
  return value;
}

function assertRecordKind(value: string): CanonicalRecordKind {
  const kind = canonicalRecordKinds.find((candidate) => candidate === value);
  if (!kind) {
    throw new CanonicalInspectionError(
      "CANONICAL_RECORD_KIND_INVALID",
      "That record kind is not one this pipeline stores.",
      400,
    );
  }
  return kind;
}

function assertSearchTerm(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > CANONICAL_EXTERNAL_ID_MAX_LENGTH) {
    throw new CanonicalInspectionError(
      "CANONICAL_SEARCH_INVALID",
      "That identifier is longer than any this pipeline stores.",
      400,
    );
  }
  return trimmed;
}

function resolveLimit(requested: number | undefined): number {
  if (requested === undefined) return CANONICAL_PAGE_SIZE_DEFAULT;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new CanonicalInspectionError(
      "CANONICAL_PAGE_SIZE_INVALID",
      "That page size is not valid.",
      400,
    );
  }
  // Bounded server-side: a caller asking for more gets the maximum, not an
  // unbounded read.
  return Math.min(requested, CANONICAL_PAGE_SIZE_MAX);
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Collapses any store failure into one code carrying no driver detail. */
async function throughStore<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (reason) {
    if (reason instanceof CanonicalInspectionError) throw reason;
    throw new CanonicalInspectionError(
      "CANONICAL_STORE_UNAVAILABLE",
      "Canonical data is temporarily unavailable.",
      503,
    );
  }
}

export class CanonicalInspectionService {
  constructor(
    private readonly repository: CanonicalInspectionRepository,
  ) {}

  async listProviders(
    organizationId: string,
  ): Promise<readonly CanonicalProviderRow[]> {
    return await throughStore(async () => {
      const rows = await this.repository.listProviders(organizationId);
      return rows.map((row) => ({
        platformKey: row.platformKey,
        displayName: row.displayName,
        state: row.state,
      }));
    });
  }

  async summarizeProvider(input: {
    readonly organizationId: string;
    readonly platformKey: string;
  }): Promise<CanonicalProviderSummary> {
    await this.assertProvider(input);
    return await throughStore(async () => {
      const kinds = await Promise.all(
        canonicalRecordKinds.map(async (recordKind) => {
          // The count decides whether the collection-time aggregate is
          // affordable, so it is read first rather than alongside.
          const counted = await this.repository.countBounded({
            ...input,
            recordKind,
            bound: CANONICAL_COUNT_BOUND,
          });
          const recency = await this.repository.kindRecency({
            ...input,
            recordKind,
            collectedExtrema: !counted.bounded,
          });
          return {
            recordKind,
            count: counted.count,
            precision: counted.bounded ? ("at_least" as const) : ("exact" as const),
            oldestCollectedAt: isoOrNull(recency.oldestCollectedAt),
            newestCollectedAt: isoOrNull(recency.newestCollectedAt),
            oldestAcceptedAt: isoOrNull(recency.oldestAcceptedAt),
            newestAcceptedAt: isoOrNull(recency.newestAcceptedAt),
            collectedExtremaComplete: recency.collectedExtremaComplete,
          };
        }),
      );
      return { platformKey: input.platformKey, kinds };
    });
  }

  async listEntities(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: string;
    readonly externalId?: string;
    readonly search?: string;
    readonly page?: number;
    readonly limit?: number;
    readonly direction?: string;
  }): Promise<CanonicalEntityPage> {
    const recordKind = assertRecordKind(input.recordKind);
    const externalId = assertSearchTerm(input.externalId);
    const search = assertSearchTerm(input.search);
    const limit = resolveLimit(input.limit);
    const requestedPage = assertPage(input.page);
    const direction = input.direction === "desc" ? "desc" : "asc";
    await this.assertProvider(input);

    // A page beyond the scan bound resolves to the deepest reachable page
    // rather than an empty result, which would read as "no records here".
    const maxPage = Math.floor(CANONICAL_MAX_OFFSET / limit) + 1;
    const page = Math.min(requestedPage, maxPage);
    const depthCapped = page !== requestedPage;

    return await throughStore(async () => {
      const result = await this.repository.listEntities({
        organizationId: input.organizationId,
        platformKey: input.platformKey,
        recordKind,
        externalId,
        externalIdPrefix: externalId ? undefined : search,
        offset: (page - 1) * limit,
        limit,
        direction,
      });
      return {
        items: result.items.map((row) => ({
          entityId: row.entityId,
          platformKey: row.platformKey,
          recordKind: row.recordKind,
          externalId: row.externalId,
          revisionNumber: row.revisionNumber,
          sourceUpdatedAt: isoOrNull(row.sourceUpdatedAt),
          sourceCollectedAt: isoOrNull(row.sourceCollectedAt),
          acceptedAt: isoOrNull(row.acceptedAt),
        })),
        page,
        pageSize: limit,
        hasMore: result.hasMore,
        depthCapped,
        direction,
      };
    });
  }

  async readEntity(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly recordKind: string;
    readonly externalId: string;
  }): Promise<CanonicalEntityDetail> {
    const recordKind = assertRecordKind(input.recordKind);
    const externalId = assertSearchTerm(input.externalId);
    if (!externalId) {
      throw new CanonicalInspectionError(
        "CANONICAL_ENTITY_UNKNOWN",
        "That record does not exist for this provider.",
        404,
      );
    }
    await this.assertProvider(input);

    const row = await throughStore(async () =>
      this.repository.readEntity({
        organizationId: input.organizationId,
        platformKey: input.platformKey,
        recordKind,
        externalId,
      }),
    );
    if (!row) {
      throw new CanonicalInspectionError(
        "CANONICAL_ENTITY_UNKNOWN",
        "That record does not exist for this provider.",
        404,
      );
    }

    return {
      entityId: row.entityId,
      platformKey: row.platformKey,
      recordKind: row.recordKind,
      externalId: row.externalId,
      revisionNumber: row.revisionNumber,
      sourceUpdatedAt: isoOrNull(row.sourceUpdatedAt),
      sourceCollectedAt: isoOrNull(row.sourceCollectedAt),
      acceptedAt: isoOrNull(row.acceptedAt),
      // Canonical content is business data and is returned as stored, but it
      // still passes through redaction: a mapper that ever carried a token into
      // content must not turn this surface into the place it surfaces.
      content: redactSensitive(row.content),
      contentHash: row.contentHash,
      provenanceHash: row.provenanceHash,
      provenance: summarizeProvenance(row.provenance),
      relationships: [...row.relationships],
    };
  }

  private async assertProvider(input: {
    readonly organizationId: string;
    readonly platformKey: string;
  }): Promise<void> {
    const exists = await throughStore(async () =>
      this.repository.providerExists(input),
    );
    if (!exists) {
      throw new CanonicalInspectionError(
        "CANONICAL_PROVIDER_UNKNOWN",
        "That provider is not configured in this workspace.",
        404,
      );
    }
  }
}
