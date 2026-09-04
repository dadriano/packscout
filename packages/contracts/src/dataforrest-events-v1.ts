import { z } from "zod";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_SOURCE_CONTRACT_VERSION,
  launchProviderKeys,
  launchRecordIdScopeDeclarations,
  opaqueCursorValueSchema,
  providerIdentityNamespaceByLaunchProvider,
  providerSourceLaunchBounds,
  sourceAdapterManifestV1Schema,
  type LaunchProviderKey,
  type LaunchRecordIdScopeKey,
  type NormalizedContinuation,
  type OpaqueCursorEnvelope,
  type SourceAdapterManifestV1,
} from "./provider-source-contract-v1.ts";
import {
  emptyNormalizedProviderFacts,
  type NormalizedProviderFacts,
} from "./provider-source-facts-v1.ts";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
} from "./dataforrest-events-v1-adapter-versions.ts";
import { readDataforrestProviderFacts } from
  "./dataforrest-provider-facts-registry.ts";
import { adaptDataforrestCollectorCryptRecordV2 } from
  "./dataforrest-collector-crypt-record-v2.ts";
import {
  normalizedProviderObservationSchema,
  type NormalizedProviderObservation,
} from "./provider-source-observation-v1.ts";

export const DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY =
  "dataforrest-events-v1" as const;
export {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
} from "./dataforrest-events-v1-adapter-versions.ts";
export const DATAFORREST_EVENTS_V1_CONNECTION_TYPE_KEY =
  "dataforrest-events-connection-v1" as const;
export const DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY =
  "dataforrest-cursor-v1" as const;
export const DATAFORREST_EVENTS_V1_ENDPOINT =
  "https://198.204.245.26.sslip.io/v1/events" as const;
export const DATAFORREST_EVENTS_V1_MAXIMUM_PAGE_LIMIT = 5_000;
export const DATAFORREST_CLUTCHPACKS_DISTRIBUTED_PAGE_TARGET_RECORDS = 2_000;
export const DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS = 1_000;
export const DATAFORREST_COLLECTOR_CRYPT_CATALOG_PAGE_TARGET_RECORDS = 100;
export const DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS = 100;
// Only the reviewed Courtyard-v2 profile and its catalog-filter derivative admit
// this response budget. Historical profiles retain their exact 8 MiB budget.
export const DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES =
  32 * 1024 * 1024;
export const DATAFORREST_EVENTS_V1_HISTORICAL_MAXIMUM_JSON_NODES = 480_000;
// The exact blocked 100-record Courtyard page has 598,207 JSON values. Only
// this capacity revision and its catalog derivative admit more.
export const DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES = 640_000;

export const dataforrestIdentityNamespaceByProvider =
  providerIdentityNamespaceByLaunchProvider;

const timestampSchema = z.iso.datetime({ offset: true });
const providerRecordIdSchema = z.string().trim().min(1).max(4_096);
const nativeDataSchema = z.record(z.string(), z.json());
const dataforrestRawBase = {
  platform: z.enum(launchProviderKeys),
  record_id: providerRecordIdSchema,
  occurred_at: timestampSchema,
  collected_at: timestampSchema,
  data: nativeDataSchema,
} as const;

export const dataforrestCatalogRecordV1Schema = z
  .object({
    ...dataforrestRawBase,
    stream: z.literal("catalog"),
    entity: z.enum(["pack", "card"]),
    first_seen_at: timestampSchema,
    available: z.boolean().nullable(),
  })
  .strict();

export const dataforrestPullRecordV1Schema = z
  .object({
    ...dataforrestRawBase,
    stream: z.literal("pulls"),
    pack_id: providerRecordIdSchema.nullable(),
    card_id: providerRecordIdSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pack_id === null && value.card_id === null) {
      context.addIssue({
        code: "custom",
        message: "dataforrest_events.pull_relationships_missing",
        path: ["card_id"],
      });
    }
  });

export const dataforrestTradeRecordV1Schema = z
  .object({
    ...dataforrestRawBase,
    stream: z.literal("trades"),
    card_id: providerRecordIdSchema,
    event_type: z.string().trim().min(1).max(128),
    amount: z.number().finite().nullable(),
    currency: z.string().trim().min(1).max(128).nullable(),
    payment_method: z.string().trim().min(1).max(256).nullable(),
    tx_hash: z.string().trim().min(1).max(4_096).nullable(),
  })
  .strict();

export const dataforrestEventRecordV1Schema = z.discriminatedUnion("stream", [
  dataforrestCatalogRecordV1Schema,
  dataforrestPullRecordV1Schema,
  dataforrestTradeRecordV1Schema,
]);

export const dataforrestRawRecordEnvelopeV1Schema = z
  .record(z.string().min(1).max(128), z.json())
  .refine((value) => Object.keys(value).length <= 64, {
    message: "dataforrest_events.record_field_limit_exceeded",
  });

export const dataforrestOpaqueCursorV1Schema = opaqueCursorValueSchema
  .refine((value) => value.trim().length > 0, {
    message: "dataforrest_events.invalid_cursor",
  });

export const dataforrestEventsPageV1Schema = z
  .object({
    records: z.array(dataforrestRawRecordEnvelopeV1Schema)
      .max(DATAFORREST_EVENTS_V1_MAXIMUM_PAGE_LIMIT),
    next_cursor: dataforrestOpaqueCursorV1Schema,
    poll_after_seconds: z.union([z.literal(0), z.literal(60)]),
  })
  .strict();

export const dataforrestEventsConnectionConfigurationV1Schema = z
  .object({
    endpoint: z.literal(DATAFORREST_EVENTS_V1_ENDPOINT),
    bearerToken: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) =>
          value === value.trim() &&
          [...value].every((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint > 31 && codePoint !== 127;
          }),
        {
          message: "dataforrest_events.invalid_bearer_token",
        },
      ),
  })
  .strict();

export const dataforrestEventsSourceConfigurationV1Schema = z
  .object({ platform: z.enum(launchProviderKeys) })
  .strict();

export const dataforrestEventsCatalogSourceConfigurationV1Schema = z
  .object({
    platform: z.enum(launchProviderKeys),
    stream: z.literal("catalog"),
  })
  .strict();

export function dataforrestEventsSourceConfigurationSchemaForAdapter(
  adapterVersion: string,
):
  | typeof dataforrestEventsSourceConfigurationV1Schema
  | typeof dataforrestEventsCatalogSourceConfigurationV1Schema {
  switch (adapterVersion) {
    case DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION:
    case DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION:
    case DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION:
    case DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION:
    case DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION:
      return dataforrestEventsCatalogSourceConfigurationV1Schema;
    case DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION:
    case DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION:
    case DATAFORREST_EVENTS_V1_ADAPTER_VERSION:
    case DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION:
    case DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION:
    case DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION:
    case DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION:
      return dataforrestEventsSourceConfigurationV1Schema;
    default:
      throw new RangeError("dataforrest_events.adapter_version_unsupported");
  }
}

/**
 * Applies only version-owned native-envelope adaptations before strict parsing.
 * Historical adapter identities remain byte-for-byte reproducible.
 */
export function adaptDataforrestEventRecordForAdapter(
  record: Readonly<Record<string, unknown>>,
  adapterVersion: string,
): Readonly<Record<string, unknown>> {
  switch (adapterVersion) {
    case DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION:
      return adaptDataforrestCollectorCryptRecordV2(record) as Readonly<
        Record<string, unknown>
      >;
    case DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION:
    case DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION:
    case DATAFORREST_EVENTS_V1_ADAPTER_VERSION:
    case DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION:
    case DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION:
    case DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION:
    case DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION:
    case DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION:
    case DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION:
    case DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION:
    case DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION:
      return record;
    default:
      throw new RangeError("dataforrest_events.adapter_version_unsupported");
  }
}

const dataforrestProviderDeclarations = launchProviderKeys.map((provider) => ({
  provider,
  identityNamespaceKey: dataforrestIdentityNamespaceByProvider[provider],
  recordIdScopes: [...launchRecordIdScopeDeclarations],
}));

function dataforrestEventsSourceAdapterManifest(
  adapterVersion:
    | typeof DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION
    | typeof DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION
    | typeof DATAFORREST_EVENTS_V1_ADAPTER_VERSION
    | typeof DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION
    | typeof DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION
    | typeof DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION
    | typeof DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION
    | typeof DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION
    | typeof DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION
    | typeof DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION
    | typeof DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION
    | typeof DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION
    | typeof DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION
    | typeof DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION
    | typeof DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION
    | typeof DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION
    | typeof DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION
    | typeof DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION
    | typeof DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION
    | typeof DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION
    | typeof DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION
    | typeof DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
  options: Readonly<{
    pageLimit?: number;
    maximumResponseBytes?: number;
    supportedProviders?: typeof dataforrestProviderDeclarations;
  }> = {},
) {
  return sourceAdapterManifestV1Schema.parse({
    providerSourceContractVersion: PROVIDER_SOURCE_CONTRACT_VERSION,
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    adapterVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    compatibleConnectionTypeKey: DATAFORREST_EVENTS_V1_CONNECTION_TYPE_KEY,
    cursorCodecKey: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    operatorLabel: "DataForrest Events V1",
    requestBounds: {
      // Shared source revisions pin a configurable request size below this
      // ceiling; distributed revisions retain their explicit immutable profile.
      pageLimit: options.pageLimit ?? providerSourceLaunchBounds.recordsPerRequest.maximum,
      maximumResponseBytes: options.maximumResponseBytes ?? providerSourceLaunchBounds.maximumResponseBytes,
      timeoutMilliseconds: providerSourceLaunchBounds.requestTimeoutMilliseconds,
    },
    maximumPlatformRequestCap:
      providerSourceLaunchBounds.stablePlatformRequestCap,
    capabilities: {
      connectionTest: true,
      sourceTest: true,
      pageRead: true,
      cancellation: true,
    },
    supportedProviders:
      options.supportedProviders ?? dataforrestProviderDeclarations,
  }) satisfies SourceAdapterManifestV1;
}

/** Retained only so already-pinned source revisions remain reproducible. */
export const dataforrestEventsV1LegacySourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  );

/** Retained only so adapter-v2 source revisions remain reproducible. */
export const dataforrestEventsV1V2SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  );

export const dataforrestEventsV1SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(DATAFORREST_EVENTS_V1_ADAPTER_VERSION);

/**
 * Provider-local request profile for the pre-launch distributed ClutchPacks
 * importer. Its distinct adapter identity fixes the approved 2,000-record API
 * request independently of the shared source's configurable request setting.
 */
export const dataforrestClutchpacksDistributedSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "clutchpacks",
      ),
    },
  );

/**
 * Immutable distributed profile for the three remaining launch providers.
 * Provider-specific interpretation stays pinned by each mapper descriptor;
 * this manifest owns only their shared DataForrest wire and the evidenced
 * 100-record bound. Live Courtyard censuses proved that later 500-record and
 * 250-record responses can breach the fixed 8 MiB response ceiling.
 */
export const dataforrestLaunchDistributedSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider !== "clutchpacks",
      ),
    },
  );

/** Collector-only request profile; historical launch-v1 remains at 100. */
export const dataforrestCollectorCryptDistributedSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "collector_crypt",
      ),
    },
  );

/**
 * Collector-only event profile with the reviewed native catalog-card and
 * catalog-pack interpretation. Distributed-v1 remains reproducible.
 */
export const dataforrestCollectorCryptDistributedV2SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
    {
      pageLimit: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "collector_crypt",
      ),
    },
  );

/**
 * Collector-only distributed (all-stream) profile carrying BOTH the
 * distributed-v2 card interpretation and the reviewed native catalog-PACK
 * reader. Transport bounds are copied from distributed-v2 exactly; only the
 * provider-facts admission differs, and adapter identities are immutable.
 */
export const dataforrestCollectorCryptDistributedV3SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
    {
      pageLimit: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "collector_crypt",
      ),
    },
  );

/** Catalog-only Collector Crypt profile; distributed-v1 remains unfiltered. */
export const dataforrestCollectorCryptCatalogSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "collector_crypt",
      ),
    },
  );

/**
 * Catalog-only Collector profile for the reviewed native record shapes. The
 * smaller bound is independently evidenced below the fixed 8 MiB ceiling.
 */
export const dataforrestCollectorCryptCatalogV2SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
    {
      pageLimit: DATAFORREST_COLLECTOR_CRYPT_CATALOG_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "collector_crypt",
      ),
    },
  );

/**
 * Catalog-only Collector profile that adds the reviewed native catalog-PACK
 * interpretation. Identical transport bounds to catalog-v2; the new identity
 * exists solely because adapter versions are immutable admissions and
 * catalog-v2 admitted a card reader only.
 */
export const dataforrestCollectorCryptCatalogV3SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
    {
      pageLimit: DATAFORREST_COLLECTOR_CRYPT_CATALOG_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "collector_crypt",
      ),
    },
  );

/** Courtyard-only native-card interpretation; shared launch-v1 stays immutable. */
export const dataforrestCourtyardDistributedSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "courtyard",
      ),
    },
  );

/** Larger reviewed byte/graph admission only; Courtyard-v1 native semantics are unchanged. */
export const dataforrestCourtyardDistributedV2SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      maximumResponseBytes: DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "courtyard",
      ),
    },
  );

/**
 * Courtyard distributed (all-stream) profile carrying BOTH the distributed-v2
 * card interpretation and the reviewed native catalog-PACK reader. Transport
 * bounds are copied from distributed-v2 exactly, including its reviewed 32 MiB
 * response and 640,000-node admissions.
 */
export const dataforrestCourtyardDistributedV3SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      maximumResponseBytes: DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "courtyard",
      ),
    },
  );

/** Catalog-only Courtyard profile with the reviewed distributed-v2 bounds. */
export const dataforrestCourtyardCatalogSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      maximumResponseBytes: DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "courtyard",
      ),
    },
  );

/**
 * Catalog-only Courtyard profile that adds the reviewed native catalog-PACK
 * interpretation. Transport bounds are copied from catalog-v1, including its
 * reviewed 32 MiB response and 640,000-node admissions.
 */
export const dataforrestCourtyardCatalogV2SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      maximumResponseBytes: DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_RESPONSE_BYTES,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "courtyard",
      ),
    },
  );

/** Phygitals-only native-card interpretation; shared launch-v1 stays immutable. */
export const dataforrestPhygitalsDistributedSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "phygitals",
      ),
    },
  );

/** Adds reviewed inventory/NFT label precedence without redefining prior profiles. */
export const dataforrestPhygitalsDistributedV2SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "phygitals",
      ),
    },
  );

/**
 * Phygitals distributed (all-stream) profile carrying BOTH the distributed-v2
 * card interpretation and the reviewed native catalog-PACK reader. Transport
 * bounds are copied from distributed-v2 exactly.
 */
export const dataforrestPhygitalsDistributedV3SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "phygitals",
      ),
    },
  );

/**
 * Phygitals distributed (all-stream) profile carrying the distributed-v2 card
 * interpretation and the catalog-PACK reader V2, which binds the published
 * rarity distribution as a probability-only EV input. Transport bounds are
 * copied from distributed-v3 exactly.
 */
export const dataforrestPhygitalsDistributedV4SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "phygitals",
      ),
    },
  );

/** Catalog-only Phygitals profile with distributed-v2 native semantics. */
export const dataforrestPhygitalsCatalogSourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "phygitals",
      ),
    },
  );

/**
 * Catalog-only Phygitals profile that adds the reviewed native catalog-PACK
 * interpretation. Identical transport bounds to catalog-v1.
 */
export const dataforrestPhygitalsCatalogV2SourceAdapterManifest =
  dataforrestEventsSourceAdapterManifest(
    DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
    {
      pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      supportedProviders: dataforrestProviderDeclarations.filter(
        ({ provider }) => provider === "phygitals",
      ),
    },
  );

export const dataforrestEventsV1SourceAdapterManifests = Object.freeze([
  dataforrestEventsV1LegacySourceAdapterManifest,
  dataforrestEventsV1V2SourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
  dataforrestCollectorCryptDistributedV3SourceAdapterManifest,
  dataforrestCollectorCryptCatalogSourceAdapterManifest,
  dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
  dataforrestCollectorCryptCatalogV3SourceAdapterManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestCourtyardDistributedV3SourceAdapterManifest,
  dataforrestCourtyardCatalogSourceAdapterManifest,
  dataforrestCourtyardCatalogV2SourceAdapterManifest,
  dataforrestPhygitalsDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  dataforrestPhygitalsDistributedV3SourceAdapterManifest,
  dataforrestPhygitalsDistributedV4SourceAdapterManifest,
  dataforrestPhygitalsCatalogSourceAdapterManifest,
  dataforrestPhygitalsCatalogV2SourceAdapterManifest,
]);

const dataforrestJsonNodeBudgets = new Map<string, number>([
  ...dataforrestEventsV1SourceAdapterManifests.map((manifest): [string, number] =>
    [manifest.adapterVersion, DATAFORREST_EVENTS_V1_HISTORICAL_MAXIMUM_JSON_NODES]),
  [DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION, DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES],
  [DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION, DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES],
  [DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION, DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES],
  [DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION, DATAFORREST_COURTYARD_DISTRIBUTED_V2_MAXIMUM_JSON_NODES],
]);
/** Exact immutable adapter admission, not a caller-selected or central mutable limit. */
export function dataforrestEventsJsonNodeBudget(adapterVersion: string): number | null {
  return dataforrestJsonNodeBudgets.get(adapterVersion) ?? null;
}

export type DataforrestEventRecordV1 = z.infer<
  typeof dataforrestEventRecordV1Schema
>;
export type DataforrestEventsPageV1 = z.infer<
  typeof dataforrestEventsPageV1Schema
>;
type DataforrestDisplayNameField = "name" | "provider_label";

const dataforrestProviderLabelFields = Object.freeze({
  pack: "provider_label",
  card: "provider_label",
  pull: "provider_label",
  trade: "provider_label",
} as const);

const dataforrestNativePackNameFields = Object.freeze({
  pack: "name",
  card: "provider_label",
  pull: "provider_label",
  trade: "provider_label",
} as const);

const dataforrestDisplayNameFieldByProvider = Object.freeze({
  courtyard: dataforrestProviderLabelFields,
  collector_crypt: dataforrestNativePackNameFields,
  phygitals: dataforrestNativePackNameFields,
  clutchpacks: dataforrestNativePackNameFields,
} as const satisfies Readonly<
  Record<
    LaunchProviderKey,
    Readonly<
      Record<NormalizedProviderFacts["kind"], DataforrestDisplayNameField>
    >
  >
>);

function dataforrestProviderFacts(
  provider: LaunchProviderKey,
  kind: NormalizedProviderFacts["kind"],
  nativeData: Readonly<Record<string, unknown>>,
  adapterVersion: string,
): NormalizedProviderFacts {
  const adapted = readDataforrestProviderFacts(
    adapterVersion,
    provider,
    kind,
    nativeData,
  );
  if (adapted) return adapted;
  const empty = emptyNormalizedProviderFacts(kind);
  const displayNameField = dataforrestDisplayNameFieldByProvider[provider][kind];
  const providerDisplayName = nativeData[displayNameField];
  const displayName = providerDisplayName === undefined || providerDisplayName === null
    ? { state: "absent" as const }
    : typeof providerDisplayName === "string" &&
        providerDisplayName.trim().length > 0 &&
        providerDisplayName.trim().length <= 10_000
      ? { state: "present" as const, value: providerDisplayName.trim() }
      : { state: "malformed" as const };
  return { ...empty, displayName } as NormalizedProviderFacts;
}

export function dataforrestRecordIdScope(
  record: DataforrestEventRecordV1,
): LaunchRecordIdScopeKey {
  if (record.stream === "catalog") {
    return record.entity === "pack" ? "catalog-pack-v1" : "catalog-card-v1";
  }
  return record.stream === "pulls" ? "pull-v1" : "trade-v1";
}

export function normalizeDataforrestEventRecordForAdapter(
  record: DataforrestEventRecordV1,
  expectedProvider: LaunchProviderKey,
  protectedNativeEvidenceRef: string,
  adapterVersion: string,
): NormalizedProviderObservation {
  if (
    adapterVersion !== DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION &&
    adapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION &&
    adapterVersion !== DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION &&
    adapterVersion !== DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION &&
    adapterVersion !== DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION &&
    adapterVersion !== DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION &&
    adapterVersion !== DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION &&
    adapterVersion !== DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION &&
    adapterVersion !== DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION &&
    adapterVersion !== DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION &&
    adapterVersion !== DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION &&
    adapterVersion !== DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION &&
    adapterVersion !== DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION
  ) {
    throw new RangeError("dataforrest_events.adapter_version_unsupported");
  }
  if (record.platform !== expectedProvider) {
    throw new RangeError("dataforrest_events.platform_mismatch");
  }
  const base = {
    providerRecordIdentity: {
      recordIdScopeKey: dataforrestRecordIdScope(record),
      providerRecordId: record.record_id,
    },
    effectiveAt: record.occurred_at,
    collectedAt: record.collected_at,
    protectedNativeEvidenceRef,
  } as const;

  if (record.stream === "catalog") {
    return normalizedProviderObservationSchema.parse({
      ...base,
      kind: "catalog",
      entity: record.entity,
      firstSeenAt: record.first_seen_at,
      availability: record.available === null
        ? "unknown"
        : record.available
          ? "available"
          : "unavailable",
      providerFacts: dataforrestProviderFacts(
        expectedProvider,
        record.entity,
        record.data,
        adapterVersion,
      ),
      relationships: [],
    });
  }

  if (record.stream === "pulls") {
    const relationships = [
      ...(record.pack_id === null
        ? []
        : [{
            relationship: "pack" as const,
            target: {
              recordIdScopeKey: "catalog-pack-v1" as const,
              providerRecordId: record.pack_id,
            },
          }]),
      ...(record.card_id === null
        ? []
        : [{
            relationship: "card" as const,
            target: {
              recordIdScopeKey: "catalog-card-v1" as const,
              providerRecordId: record.card_id,
            },
          }]),
    ];
    return normalizedProviderObservationSchema.parse({
      ...base,
      kind: "pull",
      providerFacts: dataforrestProviderFacts(
        expectedProvider,
        "pull",
        record.data,
        adapterVersion,
      ),
      relationships,
    });
  }

  return normalizedProviderObservationSchema.parse({
    ...base,
    kind: "trade",
    providerFacts: dataforrestProviderFacts(
      expectedProvider,
      "trade",
      record.data,
      adapterVersion,
    ),
    relationships: [
      {
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: record.card_id,
        },
      },
    ],
    eventType: record.event_type,
    amount: record.amount,
    currency: record.currency,
    paymentMethod: record.payment_method,
    protectedTransactionEvidenceRef: record.tx_hash === null
      ? null
      : `${protectedNativeEvidenceRef}:transaction`,
  });
}

/** Normalizes with the sole version advertised for new source revisions. */
export function normalizeDataforrestEventRecord(
  record: DataforrestEventRecordV1,
  expectedProvider: LaunchProviderKey,
  protectedNativeEvidenceRef: string,
): NormalizedProviderObservation {
  return normalizeDataforrestEventRecordForAdapter(
    record,
    expectedProvider,
    protectedNativeEvidenceRef,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
}

export function dataforrestContinuation(
  page: DataforrestEventsPageV1,
): NormalizedContinuation {
  return page.poll_after_seconds === 0
    ? { kind: "continue" }
    : { kind: "poll_after", minimumDelaySeconds: 60 };
}

export function dataforrestNextCursor(
  current: OpaqueCursorEnvelope,
  page: DataforrestEventsPageV1,
): OpaqueCursorEnvelope {
  return {
    ...current,
    value: page.next_cursor,
  };
}
