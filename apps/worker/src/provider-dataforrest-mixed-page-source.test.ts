import assert from "node:assert/strict";
import test from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  type DataforrestEventRecordV1,
  type DataforrestEventsPageV1,
} from "@packscout/contracts";
import {
  PROVIDER_MIXED_PAGE_MAX_BYTES,
  PROVIDER_MIXED_PAGE_MAX_RECORDS,
  providerMixedPageCanonicalBytes,
  providerMixedCursorFingerprint,
  validateProviderMixedPage,
  type CanonicalJsonValue,
} from "@packscout/database";
import {
  DataforrestEventsSourceAdapter,
  type SourceAdapterRequestTerminalizationInput,
} from "@packscout/services";
import type {
  DataforrestSourceAuthorityRequest,
  ResolvedDataforrestSourceAuthority,
} from
  "./dataforrest-source-authority-resolver.ts";
import {
  ProviderDataforrestMixedPageSource,
  ProviderDataforrestSourceError,
} from "./provider-dataforrest-mixed-page-source.ts";
import type { ProviderCapturePageSourceInput } from
  "./provider-capture-source-contract.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const providerId = "11111111-1111-4111-8111-111111111111";
const configVersionId = "22222222-2222-4222-8222-222222222222";
const sourceCredentialVersionId =
  "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const bearerToken = "fixture-dataforrest-bearer-token";
const rawMarker = "protected-native-value-must-not-escape";
const actorMarker = "unapproved-native-actor-must-not-escape";

const authority = Object.freeze({
  providerId,
  providerKey: "clutchpacks",
  configVersionId,
  configVersionNumber: 7n,
  configuration: Object.freeze({
    adapterKey: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    settings: Object.freeze({}),
  }),
});

const resolvedAuthority: ResolvedDataforrestSourceAuthority = Object.freeze({
  organizationId,
  providerId,
  providerKey: "clutchpacks",
  configVersionId,
  configVersionNumber: 7n,
  adapterKey: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  sourceAdapterVersion: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  sourceCredentialVersionId,
  sourceCredentialVersionNumber: 3n,
  connectionConfiguration: Object.freeze({
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken,
  }),
  sourceConfiguration: Object.freeze({ platform: "clutchpacks" }),
});

function packRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    stream: "catalog" as const,
    platform: "clutchpacks" as const,
    record_id: recordId,
    occurred_at: "2026-08-29T12:00:00.000Z",
    collected_at: "2026-08-29T12:00:01.000Z",
    entity: "pack" as const,
    first_seen_at: "2026-08-29T12:00:00.000Z",
    available: true,
    data: {
      name: "Fixture Clutch Pack",
      description: "One card per pack.",
      category: { name: "Sports" },
      image_url: "https://images.example.invalid/pack.jpg",
      price: {
        price_amount: "25.00",
        currency: { code: "USD", decimals: 2 },
      },
      average_value: "30.00",
      sold_out: false,
      series_hits: [{
        id: "nested-card-must-not-be-inferred",
        title: rawMarker,
        front_image_url: "https://images.example.invalid/card.jpg",
        current_price: "$30.00",
      }],
      price_bucket_odds: [{
        bucket_id: "base",
        name: "Base",
        drawable_count: 1,
        min_price: "$30.00",
        max_price: "$30.00",
        preview_cards: [],
        pool_cards: [],
      }],
      raw_marker: rawMarker,
    },
  };
}

function minimalPackRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    stream: "catalog",
    platform: "clutchpacks",
    record_id: recordId,
    occurred_at: "2026-08-29T12:00:00.000Z",
    collected_at: "2026-08-29T12:00:01.000Z",
    entity: "pack",
    first_seen_at: "2026-08-29T12:00:00.000Z",
    available: true,
    data: { name: `Pack ${recordId}` },
  };
}

function categorizedPackRecord(
  recordId: string,
  categoryName: string,
  description?: string,
): DataforrestEventRecordV1 {
  return {
    ...minimalPackRecord(recordId),
    data: {
      name: `Pack ${recordId}`,
      category: { name: categoryName },
      ...(description === undefined ? {} : { description }),
    },
  };
}

function cardRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    stream: "catalog",
    platform: "clutchpacks",
    record_id: recordId,
    occurred_at: "2026-08-29T12:01:00.000Z",
    collected_at: "2026-08-29T12:01:01.000Z",
    entity: "card",
    first_seen_at: "2026-08-29T12:01:00.000Z",
    available: true,
    data: {
      asset: {
        title: "Fixture Direct Card",
        name: actorMarker,
        subtype: "Basketball",
        description: "Approved card description.",
        formatted_current_price: "$42.50",
        front_image_url: "https://images.example.invalid/direct-card.jpg",
      },
      raw_marker: rawMarker,
    },
  };
}

function unmappableCardRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    ...cardRecord(recordId),
    data: {
      asset: {
        title: "",
        front_image_url: rawMarker,
      },
    },
  };
}

function unmappablePackRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    ...minimalPackRecord(recordId),
    data: { name: "" },
  };
}

function cardOnlyPullRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    stream: "pulls",
    platform: "clutchpacks",
    record_id: recordId,
    occurred_at: "2026-08-29T12:02:00.000Z",
    collected_at: "2026-08-29T12:02:01.000Z",
    pack_id: null,
    card_id: "card-001",
    data: {
      provider_label: "Approved pull label",
      user: { id: actorMarker },
      raw_marker: rawMarker,
    },
  };
}

function packOnlyPullRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    stream: "pulls",
    platform: "clutchpacks",
    record_id: recordId,
    occurred_at: "2026-08-29T12:03:00.000Z",
    collected_at: "2026-08-29T12:03:01.000Z",
    pack_id: "pack-001",
    card_id: null,
    data: { user: { id: actorMarker }, raw_marker: rawMarker },
  };
}

function nullTransactionTradeRecord(recordId: string): DataforrestEventRecordV1 {
  return {
    stream: "trades",
    platform: "clutchpacks",
    record_id: recordId,
    occurred_at: "2026-08-29T12:04:00.000Z",
    collected_at: "2026-08-29T12:04:01.000Z",
    card_id: "card-001",
    event_type: "sale",
    amount: 42.5,
    currency: "USD",
    payment_method: null,
    tx_hash: null,
    data: {
      provider_label: "Approved trade label",
      from: actorMarker,
      to: actorMarker,
      raw_marker: rawMarker,
    },
  };
}

function adapterInvalidCatalogRecord(): DataforrestEventsPageV1["records"][number] {
  return {
    stream: "catalog",
    platform: "clutchpacks",
    record_id: "",
    occurred_at: "2026-08-29T12:05:00.000Z",
    collected_at: "2026-08-29T12:05:01.000Z",
    entity: "pack",
    first_seen_at: "2026-08-29T12:05:00.000Z",
    available: true,
    data: { name: rawMarker },
    native_secret: bearerToken,
  };
}

function adapterInvalidTimestampCatalogRecord(
  recordId: string,
): DataforrestEventsPageV1["records"][number] {
  return {
    stream: "catalog",
    platform: "clutchpacks",
    record_id: recordId,
    occurred_at: "not-a-timestamp",
    collected_at: "2026-08-29T12:05:01.000Z",
    entity: "pack",
    first_seen_at: "2026-08-29T12:05:00.000Z",
    available: true,
    data: { name: rawMarker },
    native_secret: bearerToken,
  };
}

function sourcePage(input: Readonly<{
  cursor: string;
  continuation: "continue" | "head";
  records: readonly DataforrestEventsPageV1["records"][number][];
}>): DataforrestEventsPageV1 {
  return {
    records: [...input.records],
    next_cursor: input.cursor,
    poll_after_seconds: input.continuation === "continue" ? 0 : 60,
  };
}

function sourceInput(input: Readonly<{
  pageNumber?: number;
  checkpoint?: CanonicalJsonValue | null;
  checkpointFingerprint?: string | null;
}> = {}): ProviderCapturePageSourceInput {
  return {
    authority,
    runId,
    workerFence: 1n,
    pageNumber: input.pageNumber ?? 1,
    sourceCheckpoint: input.checkpoint ?? null,
    sourceCheckpointFingerprint: input.checkpointFingerprint ?? null,
    signal: new AbortController().signal,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sourceFixture(input: Readonly<{
  pages: readonly DataforrestEventsPageV1[];
  pageLimit?: number;
  resolver?: (
    request: DataforrestSourceAuthorityRequest,
  ) => Promise<ResolvedDataforrestSourceAuthority>;
  terminalize?: (
    attempt: SourceAdapterRequestTerminalizationInput,
  ) => Promise<Readonly<{
    requestAttemptId: string;
    requestLeaseId: string;
    operationScope: SourceAdapterRequestTerminalizationInput["operationScope"];
  }>>;
}>) {
  const requestedUrls: URL[] = [];
  const authorizationHeaders: Array<string | null> = [];
  const terminalizations: SourceAdapterRequestTerminalizationInput[] = [];
  const translations: Array<Readonly<{
    sourceRecordCount: number;
    normalizedRecordCount: number;
  }>> = [];
  const pages = [...input.pages];
  const adapter = new DataforrestEventsSourceAdapter(
    {
      resolveHost: async () => ["198.204.245.26"],
      httpClient: async (url, init) => {
        requestedUrls.push(new URL(url));
        authorizationHeaders.push(
          new Headers(init.headers).get("authorization"),
        );
        const page = pages.shift();
        assert.ok(page, "unexpected additional DataForrest request");
        return jsonResponse(page);
      },
    },
    input.pageLimit === undefined
      ? dataforrestClutchpacksDistributedSourceAdapterManifest
      : {
          ...dataforrestClutchpacksDistributedSourceAdapterManifest,
          requestBounds: {
            ...dataforrestClutchpacksDistributedSourceAdapterManifest
              .requestBounds,
            pageLimit: input.pageLimit,
          },
        },
  );
  const terminalize = input.terminalize ?? (async (attempt) => {
    terminalizations.push(attempt);
    return Object.freeze({
      requestAttemptId: attempt.requestAttemptId,
      requestLeaseId: attempt.requestLeaseId,
      operationScope: attempt.operationScope,
    });
  });
  const source = new ProviderDataforrestMixedPageSource({
    authorityResolver: {
      resolve: input.resolver ?? (() => Promise.resolve(resolvedAuthority)),
    },
    terminalizeRequest: async (attempt) => {
      if (input.terminalize !== undefined) terminalizations.push(attempt);
      return terminalize(attempt);
    },
    translationRecorder: {
      recordPageTranslation(input) {
        translations.push({
          sourceRecordCount: input.sourceRecordCount,
          normalizedRecordCount: input.normalizedRecordCount,
        });
        return Promise.resolve({ kind: "recorded" as const });
      },
    },
    workerId: "fixture:clutchpacks",
    adapter,
  });
  return {
    source,
    requestedUrls,
    authorizationHeaders,
    terminalizations,
    translations,
  };
}

test("live DataForrest records map directly without leaking native actors or protected evidence", async () => {
  const fixture = sourceFixture({
    pages: [
      sourcePage({
        cursor: "clutchpacks-cursor-001",
        continuation: "continue",
        records: [
          packRecord("pack-001"),
          cardRecord("card-001"),
          cardOnlyPullRecord("pull-card-only"),
          packOnlyPullRecord("pull-pack-only"),
          nullTransactionTradeRecord("trade-without-tx"),
        ],
      }),
      sourcePage({
        cursor: "clutchpacks-cursor-001",
        continuation: "head",
        records: [],
      }),
    ],
  });

  const first = validateProviderMixedPage(
    await fixture.source.nextPage(sourceInput()),
  );
  assert.equal(first.continuation, "more");
  assert.notEqual(first.nextCursor, null);
  assert.equal(first.nextCursorFingerprint,
    providerMixedCursorFingerprint(first.nextCursor));
  assert.equal(first.records.some((record) => (
    record.kind === "catalog"
    && record.entityType === "pack"
    && record.candidate.packKey === "pack:pack-001"
  )), true);
  assert.equal(first.records.some((record) => (
    record.kind === "catalog"
    && record.entityType === "collectible"
    && record.candidate.collectibleKey === "card:card-001"
    && record.candidate.displayName === "Fixture Direct Card"
  )), true);
  assert.equal(first.records.some((record) => (
    record.kind === "catalog"
    && record.entityType === "collectible"
    && record.candidate.collectibleKey ===
      "card:nested-card-must-not-be-inferred"
  )), false);
  assert.equal(first.records.some((record) => (
    record.kind === "catalog" && record.entityType === "provider_account"
  )), false);
  const pulls = first.records.filter(({ kind }) => kind === "pull");
  assert.equal(pulls.length, 2);
  assert.equal(pulls.some(({ candidate }) => (
    candidate.packKey === null
    && Array.isArray(candidate.items)
    && candidate.items.length === 1
    && typeof candidate.items[0] === "object"
    && candidate.items[0] !== null
    && !Array.isArray(candidate.items[0])
    && (candidate.items[0] as Record<string, unknown>).collectibleKey ===
      "card:card-001"
  )), true);
  assert.equal(pulls.some(({ candidate }) => (
    candidate.packKey === "pack:pack-001"
    && Array.isArray(candidate.items)
    && candidate.items.length === 1
    && typeof candidate.items[0] === "object"
    && candidate.items[0] !== null
    && !Array.isArray(candidate.items[0])
    && (candidate.items[0] as Record<string, unknown>).collectibleKey === null
  )), true);
  const marketEvent = first.records.find(({ kind }) => kind === "market_event");
  assert.ok(marketEvent);
  assert.equal(marketEvent.candidate.eventType, "sale");
  assert.equal(marketEvent.candidate.amount, "42.5");
  assert.equal(marketEvent.candidate.currency, "USD");
  assert.equal(marketEvent.candidate.fromProviderAccountKey, null);
  assert.equal(marketEvent.candidate.toProviderAccountKey, null);

  const second = validateProviderMixedPage(await fixture.source.nextPage(
    sourceInput({
      pageNumber: 2,
      checkpoint: first.nextCursor,
      checkpointFingerprint: first.nextCursorFingerprint,
    }),
  ));
  assert.equal(second.continuation, "head");
  assert.notEqual(second.nextCursor, null);
  assert.equal(
    second.nextCursorFingerprint,
    first.nextCursorFingerprint,
  );
  assert.equal(
    fixture.requestedUrls[0]?.toString(),
    `${DATAFORREST_EVENTS_V1_ENDPOINT}?platform=clutchpacks&limit=${
      dataforrestClutchpacksDistributedSourceAdapterManifest.requestBounds
        .pageLimit
    }`,
  );
  assert.equal(
    fixture.requestedUrls[1]?.searchParams.get("cursor"),
    "clutchpacks-cursor-001",
  );
  assert.deepEqual(
    fixture.authorizationHeaders,
    [`Bearer ${bearerToken}`, `Bearer ${bearerToken}`],
  );
  assert.equal(fixture.terminalizations.length, 2);
  assert.deepEqual(
    fixture.terminalizations.map(({ operationScope }) => {
      assert.equal(operationScope.operationKind, "page_read");
      if (operationScope.operationKind !== "page_read") {
        assert.fail("expected page-read operation");
      }
      return operationScope.pageLimit;
    }),
    [2_000, 2_000],
  );
  assert.deepEqual(fixture.translations, [
    { sourceRecordCount: 5, normalizedRecordCount: first.records.length },
    { sourceRecordCount: 0, normalizedRecordCount: 0 },
  ]);
  assert.equal(fixture.terminalizations.every(
    ({ outcome }) => outcome.measurements.responseBytes > 0,
  ), true);

  const durableSurface = JSON.stringify(
    { pages: [first, second], terminalizations: fixture.terminalizations },
    (_key, value: unknown) => typeof value === "bigint"
      ? value.toString()
      : value,
  );
  assert.equal(durableSurface.includes(bearerToken), false);
  assert.equal(durableSurface.includes(rawMarker), false);
  assert.equal(durableSurface.includes(actorMarker), false);
});

test("every page keeps the run's immutable config pin when the central active pointer moves", async () => {
  const nextActiveConfigVersionId =
    "55555555-5555-4555-8555-555555555555";
  let ambientActiveConfigVersionId = configVersionId;
  const resolutions: Array<Readonly<{
    requestedConfigVersionId: string;
    ambientActiveConfigVersionId: string;
  }>> = [];
  const fixture = sourceFixture({
    pages: [
      sourcePage({
        cursor: "pinned-cursor-001",
        continuation: "continue",
        records: [minimalPackRecord("pinned-pack-001")],
      }),
      sourcePage({
        cursor: "pinned-cursor-001",
        continuation: "head",
        records: [],
      }),
    ],
    resolver: (request) => {
      resolutions.push({
        requestedConfigVersionId: request.configVersionId,
        ambientActiveConfigVersionId,
      });
      return Promise.resolve(resolvedAuthority);
    },
  });

  const first = validateProviderMixedPage(
    await fixture.source.nextPage(sourceInput()),
  );
  ambientActiveConfigVersionId = nextActiveConfigVersionId;
  const second = validateProviderMixedPage(await fixture.source.nextPage(
    sourceInput({
      pageNumber: 2,
      checkpoint: first.nextCursor,
      checkpointFingerprint: first.nextCursorFingerprint,
    }),
  ));

  assert.equal(second.continuation, "head");
  assert.deepEqual(resolutions, [
    {
      requestedConfigVersionId: configVersionId,
      ambientActiveConfigVersionId: configVersionId,
    },
    {
      requestedConfigVersionId: configVersionId,
      ambientActiveConfigVersionId: nextActiveConfigVersionId,
    },
  ]);
});

test("authority resolution fails closed before a DataForrest request", async () => {
  const fixture = sourceFixture({
    pages: [sourcePage({
      cursor: "unused-cursor",
      continuation: "head",
      records: [packRecord("unused-pack")],
    })],
    resolver: () => Promise.reject(new Error("central unavailable")),
  });
  await assert.rejects(
    fixture.source.nextPage(sourceInput()),
    (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_AUTHORITY_UNAVAILABLE",
  );
  assert.equal(fixture.requestedUrls.length, 0);
  assert.equal(fixture.terminalizations.length, 0);
});

test("mapper-invalid records quarantine independently with entity-scoped source identities", async () => {
  const sharedRecordId = "shared-invalid-catalog-id";
  const fixture = sourceFixture({
    pages: [sourcePage({
      cursor: "clutchpacks-cursor-record-local-quarantine",
      continuation: "head",
      records: [
        minimalPackRecord("pack-before-invalid-card"),
        unmappablePackRecord(sharedRecordId),
        unmappableCardRecord(sharedRecordId),
        cardOnlyPullRecord("pull-after-invalid-card"),
      ],
    })],
  });

  const page = validateProviderMixedPage(
    await fixture.source.nextPage(sourceInput()),
  );
  assert.equal(page.continuation, "head");
  assert.equal(page.records.some((record) =>
    record.kind === "catalog"
    && record.entityType === "pack"
  ), true);
  assert.equal(page.records.some((record) => record.kind === "pull"), true);
  const quarantines = page.records.filter(
    (record) => record.disposition === "quarantine",
  );
  assert.equal(quarantines.length, 2);
  assert.equal(quarantines.every((record) =>
    record.kind === "catalog"
    && record.reasonCode === "SOURCE_RECORD_MAPPING_INVALID"
    && /^source:[0-9a-f]{64}$/u.test(record.sourceRecordKey ?? "")
    && JSON.stringify(record.candidate) === "{}"
  ), true);
  assert.notEqual(
    quarantines[0]?.sourceRecordKey,
    quarantines[1]?.sourceRecordKey,
  );
  assert.equal(JSON.stringify(
    page,
    (_key, value: unknown) => typeof value === "bigint"
      ? value.toString()
      : value,
  ).includes(rawMarker), false);
  assert.deepEqual(fixture.translations, [{
    sourceRecordCount: 4,
    normalizedRecordCount: page.records.length,
  }]);
});

test("adapter-invalid records quarantine locally with stable identity while valid records and continuation survive", async () => {
  const invalidTimestampRecordId = "adapter-invalid-timestamp-pack";
  const fixture = sourceFixture({
    pages: [
      sourcePage({
        cursor: "clutchpacks-cursor-adapter-invalid",
        continuation: "continue",
        records: [
          minimalPackRecord("pack-before-adapter-invalid"),
          adapterInvalidCatalogRecord(),
          adapterInvalidTimestampCatalogRecord(invalidTimestampRecordId),
        ],
      }),
      sourcePage({
        cursor: "clutchpacks-cursor-adapter-invalid",
        continuation: "head",
        records: [
          adapterInvalidCatalogRecord(),
          adapterInvalidTimestampCatalogRecord(invalidTimestampRecordId),
        ],
      }),
    ],
  });

  const first = validateProviderMixedPage(
    await fixture.source.nextPage(sourceInput()),
  );
  assert.equal(first.continuation, "more");
  assert.equal(first.records.some((record) =>
    record.disposition !== "quarantine"
    && record.kind === "catalog"
    && record.entityType === "pack"
    && record.candidate.packKey === "pack:pack-before-adapter-invalid"
  ), true);
  const quarantines = first.records.filter(
    (record) => record.disposition === "quarantine",
  );
  assert.equal(quarantines.length, 2);
  const missingIdentity = quarantines.find(({ reasonCode }) =>
    reasonCode === "SOURCE_ADAPTER_MISSING_IDENTITY"
  );
  const invalidTimestamp = quarantines.find(({ reasonCode }) =>
    reasonCode === "SOURCE_ADAPTER_INVALID_TIMESTAMP"
  );
  assert.ok(missingIdentity);
  assert.ok(invalidTimestamp);
  assert.equal(missingIdentity.kind, "catalog");
  assert.equal(missingIdentity.fieldPath, "record_id");
  assert.equal(invalidTimestamp.fieldPath, "occurred_at");
  assert.equal(
    missingIdentity.sanitizedSummary,
    "The source adapter rejected this record before canonical translation; no retry artifact is retained.",
  );
  assert.equal(
    invalidTimestamp.sanitizedSummary,
    missingIdentity.sanitizedSummary,
  );
  assert.match(missingIdentity.sourceRecordKey ?? "", /^source:[0-9a-f]{64}$/u);
  assert.match(invalidTimestamp.sourceRecordKey ?? "", /^source:[0-9a-f]{64}$/u);
  assert.notEqual(
    missingIdentity.sourceRecordKey,
    invalidTimestamp.sourceRecordKey,
  );
  assert.deepEqual(missingIdentity.candidate, {});
  assert.deepEqual(invalidTimestamp.candidate, {});

  const second = validateProviderMixedPage(await fixture.source.nextPage(
    sourceInput({
      pageNumber: 2,
      checkpoint: first.nextCursor,
      checkpointFingerprint: first.nextCursorFingerprint,
    }),
  ));
  assert.equal(second.continuation, "head");
  const replayedQuarantines = second.records.filter(
    (record) => record.disposition === "quarantine",
  );
  assert.equal(replayedQuarantines.length, 2);
  assert.deepEqual(
    Object.fromEntries(quarantines.map((record) => [
      record.reasonCode,
      record.sourceRecordKey,
    ])),
    Object.fromEntries(replayedQuarantines.map((record) => [
      record.reasonCode,
      record.sourceRecordKey,
    ])),
  );
  assert.deepEqual(fixture.translations, [
    { sourceRecordCount: 3, normalizedRecordCount: first.records.length },
    { sourceRecordCount: 2, normalizedRecordCount: second.records.length },
  ]);
  const durableSurface = JSON.stringify(
    { first, second },
    (_key, value: unknown) => typeof value === "bigint"
      ? value.toString()
      : value,
  );
  assert.equal(durableSurface.includes(rawMarker), false);
  assert.equal(durableSurface.includes(bearerToken), false);
});

test("an exact 2,000-record API page can expand to the bounded 4,000-record mixed page", async () => {
  const fixture = sourceFixture({
    pages: [sourcePage({
      cursor: "clutchpacks-cursor-normalized-boundary",
      continuation: "head",
      records: Array.from({ length: 2_000 }, (_, index) =>
        categorizedPackRecord(
          `pack-normalized-boundary-${index}`,
          `Category ${index}`,
        )
      ),
    })],
  });
  const rawPage = await fixture.source.nextPage(sourceInput());
  const page = validateProviderMixedPage(rawPage);
  assert.equal(page.records.length, PROVIDER_MIXED_PAGE_MAX_RECORDS);
  assert.equal(
    providerMixedPageCanonicalBytes(rawPage).byteLength <=
      PROVIDER_MIXED_PAGE_MAX_BYTES,
    true,
  );
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "2000");
  assert.equal(fixture.terminalizations.length, 1);
});

test("a validated source page that maps past 4,000 records fails closed after durable request audit", async () => {
  const fixture = sourceFixture({
    pageLimit: 5_000,
    pages: [sourcePage({
      cursor: "clutchpacks-cursor-oversized",
      continuation: "head",
      records: Array.from({ length: 2_001 }, (_, index) =>
        categorizedPackRecord(`pack-oversized-${index}`, `Category ${index}`)
      ),
    })],
  });
  await assert.rejects(
    fixture.source.nextPage(sourceInput()),
    (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_PAGE_INVALID",
  );
  assert.equal(fixture.requestedUrls.length, 1);
  assert.equal(fixture.terminalizations.length, 1);
  assert.equal(fixture.terminalizations[0]?.outcome.ok, true);
});

test("a 2,000-record source response that expands past 8 MiB fails closed after durable request audit", async () => {
  const fixture = sourceFixture({
    pages: [sourcePage({
      cursor: "clutchpacks-cursor-byte-oversized",
      continuation: "head",
      records: Array.from({ length: 2_000 }, (_, index) =>
        categorizedPackRecord(
          `pack-byte-oversized-${index}`,
          "Shared category",
          "x".repeat(3_500),
        )
      ),
    })],
  });
  await assert.rejects(
    fixture.source.nextPage(sourceInput()),
    (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_PAGE_INVALID",
  );
  assert.equal(fixture.requestedUrls.length, 1);
  assert.equal(fixture.terminalizations.length, 1);
  assert.equal(fixture.terminalizations[0]?.outcome.ok, true);
});

test("a missing durable terminalization receipt fences the live source safely", async () => {
  const fixture = sourceFixture({
    pages: [sourcePage({
      cursor: "clutchpacks-cursor-terminalization",
      continuation: "head",
      records: [packRecord("pack-terminalization")],
    })],
    terminalize: () => Promise.reject(new Error(
      `durable audit unavailable: ${rawMarker}`,
    )),
  });
  await assert.rejects(
    fixture.source.nextPage(sourceInput()),
    (error: unknown) => {
      assert.equal(String(error).includes(rawMarker), false);
      return error instanceof ProviderDataforrestSourceError
        && error.code === "PROVIDER_DATAFORREST_TERMINALIZATION_FAILED";
    },
  );
  assert.equal(fixture.requestedUrls.length, 1);
  assert.equal(fixture.terminalizations.length, 1);
  assert.equal(JSON.stringify(fixture.terminalizations).includes(rawMarker), false);
  assert.equal(JSON.stringify(fixture.terminalizations).includes(bearerToken), false);
});
