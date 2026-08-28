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
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
} from "./dataforrest-events-v1-adapter-versions.ts";
import { readDataforrestProviderFacts } from
  "./dataforrest-provider-facts-registry.ts";
import {
  normalizedProviderObservationSchema,
  type NormalizedProviderObservation,
} from "./provider-source-observation-v1.ts";

export const DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY =
  "dataforrest-events-v1" as const;
export {
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
} from "./dataforrest-events-v1-adapter-versions.ts";
export const DATAFORREST_EVENTS_V1_CONNECTION_TYPE_KEY =
  "dataforrest-events-connection-v1" as const;
export const DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY =
  "dataforrest-cursor-v1" as const;
export const DATAFORREST_EVENTS_V1_ENDPOINT =
  "https://198.204.245.26.sslip.io/v1/events" as const;

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
    records: z.array(dataforrestRawRecordEnvelopeV1Schema).max(5_000),
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

const dataforrestProviderDeclarations = launchProviderKeys.map((provider) => ({
  provider,
  identityNamespaceKey: dataforrestIdentityNamespaceByProvider[provider],
  recordIdScopes: [...launchRecordIdScopeDeclarations],
}));

function dataforrestEventsSourceAdapterManifest(
  adapterVersion:
    | typeof DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION
    | typeof DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION
    | typeof DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
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
      pageLimit: providerSourceLaunchBounds.recordsPerRequest.maximum,
      maximumResponseBytes: providerSourceLaunchBounds.maximumResponseBytes,
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
    supportedProviders: dataforrestProviderDeclarations,
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

export const dataforrestEventsV1SourceAdapterManifests = Object.freeze([
  dataforrestEventsV1LegacySourceAdapterManifest,
  dataforrestEventsV1V2SourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
]);

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
    adapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_VERSION
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
