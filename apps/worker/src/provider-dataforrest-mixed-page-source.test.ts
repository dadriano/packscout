import assert from "node:assert/strict";
import test from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  providerSourceLaunchBounds,
  type DataforrestEventRecordV1,
  type DataforrestEventsPageV1,
  type ProviderPageRecordCounts,
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
import {
  createProviderDataforrestLiveIntegration,
  type ProviderDataforrestLiveIntegration,
} from
  "./provider-dataforrest-live-integration.ts";
import type { ProviderCapturePageSourceInput } from
  "./provider-capture-source-contract.ts";
import { providerManualImportExecutionBudget } from "./provider-manual-import-execution-budget.ts";

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
  expiresAt: null,
  connectionConfiguration: Object.freeze({
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken,
  }),
  sourceConfiguration: Object.freeze({ platform: "clutchpacks" }),
});

const courtyardAuthority = Object.freeze({
  providerId,
  providerKey: "courtyard",
  configVersionId,
  configVersionNumber: 7n,
  configuration: Object.freeze({
    adapterKey: DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
    settings: Object.freeze({}),
  }),
});

const courtyardResolvedAuthority: ResolvedDataforrestSourceAuthority =
  Object.freeze({
    ...resolvedAuthority,
    providerKey: "courtyard",
    adapterKey: DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
    sourceAdapterVersion: DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
    sourceConfiguration: Object.freeze({ platform: "courtyard" }),
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

function courtyardRecords(): readonly DataforrestEventRecordV1[] {
  return [
    {
      stream: "catalog",
      platform: "courtyard",
      record_id: "courtyard-pack-001",
      occurred_at: "2026-08-29T13:00:00.000Z",
      collected_at: "2026-08-29T13:00:01.000Z",
      entity: "pack",
      first_seen_at: "2026-08-29T13:00:00.000Z",
      available: true,
      data: {
        provider_label: "Courtyard Fixture Pack",
        raw_marker: rawMarker,
      },
    },
    {
      stream: "catalog",
      platform: "courtyard",
      record_id: "courtyard-card-001",
      occurred_at: "2026-08-29T13:01:00.000Z",
      collected_at: "2026-08-29T13:01:01.000Z",
      entity: "card",
      first_seen_at: "2026-08-29T13:01:00.000Z",
      available: null,
      data: {
        provider_label: "Courtyard Fixture Card",
        actor: actorMarker,
      },
    },
    {
      stream: "pulls",
      platform: "courtyard",
      record_id: "courtyard-pull-001",
      occurred_at: "2026-08-29T13:02:00.000Z",
      collected_at: "2026-08-29T13:02:01.000Z",
      pack_id: "courtyard-pack-001",
      card_id: "courtyard-card-001",
      data: { raw_marker: rawMarker },
    },
    {
      stream: "trades",
      platform: "courtyard",
      record_id: "courtyard-trade-001",
      occurred_at: "2026-08-29T13:03:00.000Z",
      collected_at: "2026-08-29T13:03:01.000Z",
      card_id: "courtyard-card-001",
      event_type: "sale",
      amount: 12.5,
      currency: "USD",
      payment_method: "stripe",
      tx_hash: "courtyard-transaction-must-not-escape",
      data: { raw_marker: rawMarker },
    },
  ];
}

function courtyardUnlabeledCard(): DataforrestEventRecordV1 {
  return {
    stream: "catalog",
    platform: "courtyard",
    record_id: "courtyard-card-unlabeled",
    occurred_at: "2026-08-29T13:04:00.000Z",
    collected_at: "2026-08-29T13:04:01.000Z",
    entity: "card",
    first_seen_at: "2026-08-29T13:04:00.000Z",
    available: null,
    data: { raw_marker: rawMarker },
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
  authority?: ProviderCapturePageSourceInput["authority"];
}> = {}): ProviderCapturePageSourceInput {
  return {
    authority: input.authority ?? authority,
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
  maximumPageRecords?: number;
  integration?: ProviderDataforrestLiveIntegration;
  resolvedAuthority?: ResolvedDataforrestSourceAuthority;
  workerId?: string;
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
  const recordKindMeasurements: ProviderPageRecordCounts[] = [];
  const pages = [...input.pages];
  const baseIntegration = input.integration
    ?? createProviderDataforrestLiveIntegration(
      "clutchpacks",
      dataforrestClutchpacksDistributedSourceAdapterManifest,
    );
  const manifest = input.pageLimit === undefined
    ? baseIntegration.manifest
    : {
        ...baseIntegration.manifest,
        requestBounds: {
          ...baseIntegration.manifest.requestBounds,
          pageLimit: input.pageLimit,
        },
      };
  const integration = input.pageLimit === undefined
    ? baseIntegration
    : createProviderDataforrestLiveIntegration(
      baseIntegration.providerKey,
      manifest,
    );
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
    manifest,
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
      resolve: input.resolver ?? (() => Promise.resolve(
        input.resolvedAuthority ?? resolvedAuthority,
      )),
    },
    terminalizeRequest: async (attempt) => {
      if (input.terminalize !== undefined) terminalizations.push(attempt);
      return terminalize(attempt);
    },
    translationRecorder: {
      recordPageTranslation(input) {
        recordKindMeasurements.push(input.recordCounts);
        translations.push({
          sourceRecordCount: input.sourceRecordCount,
          normalizedRecordCount: input.normalizedRecordCount,
        });
        return Promise.resolve({ kind: "recorded" as const });
      },
    },
    workerId: input.workerId ?? "fixture:clutchpacks",
    integration,
    adapter,
    maximumPageRecords: input.maximumPageRecords,
  });
  return {
    source,
    requestedUrls,
    authorizationHeaders,
    terminalizations,
    translations,
    recordKindMeasurements,
  };
}

function phygitalsCardRecord(
  recordId: string,
  data: DataforrestEventRecordV1["data"],
): DataforrestEventRecordV1 {
  return {
    stream: "catalog",
    platform: "phygitals",
    record_id: recordId,
    occurred_at: "2026-08-30T01:00:00.000Z",
    collected_at: "2026-08-30T01:00:01.000Z",
    entity: "card",
    first_seen_at: "2026-08-30T01:00:00.000Z",
    available: true,
    data,
  };
}

function collectorSourceFixture(
  pages: readonly DataforrestEventsPageV1[],
  manifest = dataforrestCollectorCryptDistributedSourceAdapterManifest,
  maximumPageRecords?: number,
) {
  return {
    ...sourceFixture({
      pages,
      maximumPageRecords,
      integration: createProviderDataforrestLiveIntegration("collector_crypt", manifest),
      resolvedAuthority: {
        ...resolvedAuthority,
        providerKey: "collector_crypt",
        adapterKey: manifest.adapterVersion,
        sourceAdapterVersion: manifest.adapterVersion,
        sourceConfiguration: { platform: "collector_crypt" },
      },
    }),
    captureAuthority: {
      ...authority,
      providerKey: "collector_crypt",
      configuration: { adapterKey: manifest.adapterVersion, settings: {} },
    },
  };
}

function collectorPullRecords(count: number): DataforrestEventRecordV1[] {
  return Array.from({ length: count }, (_, index) => ({
    ...cardOnlyPullRecord(`collector-profile-pull-${index}`),
    platform: "collector_crypt",
  }));
}

test("remote page ceiling preserves the opaque Collector cursor, canonical ordering and original 1,000-record manifest", async () => {
  const manifest = dataforrestCollectorCryptDistributedSourceAdapterManifest;
  const originalManifest = structuredClone(manifest);
  const checkpoint = {
    sourceInstanceId: providerId, sourceRevisionId: configVersionId,
    sourceTypeKey: manifest.sourceTypeKey, adapterVersion: manifest.adapterVersion,
    cursorCodecKey: manifest.cursorCodecKey, cursorGeneration: 1,
    value: "collector/opaque+saved==?limit=1000&position=163000",
  };
  const checkpointFingerprint = providerMixedCursorFingerprint(checkpoint);
  const pages = [sourcePage({ cursor: "collector-bounded-next", continuation: "continue", records: collectorPullRecords(100) }),
    sourcePage({ cursor: "collector-bounded-head", continuation: "head", records: [] })];
  const translated = [];
  for (const mode of ["remote", "local"] as const) {
    const fixture = collectorSourceFixture(pages, manifest, providerManualImportExecutionBudget(mode).maximumPageRecords);
    const first = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({
      authority: fixture.captureAuthority, pageNumber: 2, checkpoint, checkpointFingerprint,
    })));
    translated.push(first);
    assert.equal(first.records.length, 100);
    assert.deepEqual(first.inputCursor, checkpoint);
    assert.equal(first.inputCursorFingerprint, checkpointFingerprint);
    assert.deepEqual(first.nextCursor, { ...checkpoint, value: "collector-bounded-next" });
    const second = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({
      authority: fixture.captureAuthority, pageNumber: 3,
      checkpoint: first.nextCursor, checkpointFingerprint: first.nextCursorFingerprint,
    })));
    assert.equal(second.continuation, "head");
    assert.deepEqual(fixture.requestedUrls.map(url => url.searchParams.get("cursor")), [checkpoint.value, "collector-bounded-next"]);
    const limit = mode === "remote" ? 100 : 1_000;
    assert.equal(fixture.requestedUrls.every(url => url.searchParams.get("limit") === String(limit)), true);
    assert.equal(fixture.terminalizations.every(({ operationScope }) =>
      operationScope.operationKind === "page_read" && operationScope.pageLimit === limit
      && operationScope.adapterVersion === manifest.adapterVersion), true);
    const firstScope = fixture.terminalizations[0]!.operationScope;
    assert.ok(firstScope.operationKind === "page_read");
    assert.equal(firstScope.requestedCursorFingerprint, checkpointFingerprint);
    assert.deepEqual(fixture.translations, [{ sourceRecordCount: 100, normalizedRecordCount: 100 },
      { sourceRecordCount: 0, normalizedRecordCount: 0 }]);
  }
  assert.deepEqual(translated[0], translated[1]);
  assert.deepEqual(manifest, originalManifest);
  assert.equal(manifest.requestBounds.pageLimit, 1_000);
});

test("remote 100-record request rejects a 101-record response before translation and audits the effective bound", async () => {
  const fixture = collectorSourceFixture([sourcePage({ cursor: "collector-bounded-overflow", continuation: "continue",
    records: collectorPullRecords(101) })], dataforrestCollectorCryptDistributedSourceAdapterManifest,
  providerManualImportExecutionBudget("remote").maximumPageRecords);
  await assert.rejects(fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })),
    (error: unknown) => error instanceof ProviderDataforrestSourceError && error.code === "PROVIDER_DATAFORREST_INVALID_RESPONSE");
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "100");
  assert.equal(fixture.terminalizations.length, 1);
  const scope = fixture.terminalizations[0]!.operationScope;
  assert.equal(scope.operationKind === "page_read" && scope.pageLimit, 100);
  assert.equal(fixture.terminalizations[0]!.outcome.ok, true);
  assert.deepEqual(fixture.translations, []);
});

test("page ceilings reject invalid values before I/O and never increase an adapter's smaller maximum", async () => {
  for (const maximumPageRecords of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => collectorSourceFixture([], undefined, maximumPageRecords), /page record ceiling is invalid/u);
  }
  const fixture = collectorSourceFixture([sourcePage({ cursor: "smaller-manifest-head", continuation: "head",
    records: collectorPullRecords(100) })], dataforrestLaunchDistributedSourceAdapterManifest, 1_000);
  const page = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })));
  assert.equal(page.records.length, 100);
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "100");
});

test("Collector requests and accepts exactly 1,000 records with an exact version-pinned continuation", async () => {
  const manifest = dataforrestCollectorCryptDistributedSourceAdapterManifest;
  const fixture = collectorSourceFixture([
    sourcePage({ cursor: "collector-profile-next", continuation: "continue", records: collectorPullRecords(1_000) }),
    sourcePage({ cursor: "collector-profile-head", continuation: "head", records: [] }),
  ]);
  const first = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({
    authority: fixture.captureAuthority,
  })));
  assert.equal(first.records.length, 1_000);
  assert.equal(first.records.every((record) => record.kind === "pull" && record.disposition !== "quarantine"), true);
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "1000");
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("platform"), "collector_crypt");
  const cursor = first.nextCursor as Record<string, CanonicalJsonValue>;
  assert.equal(cursor.adapterVersion, manifest.adapterVersion);
  assert.equal(cursor.cursorCodecKey, manifest.cursorCodecKey);
  assert.deepEqual(fixture.translations, [{ sourceRecordCount: 1_000, normalizedRecordCount: 1_000 }]);
  assert.deepEqual(fixture.recordKindMeasurements, [{ catalogRecordCount: 0, collectibleRecordCount: 0,
    packContentSnapshotCount: 0, pullRecordCount: 1_000, marketEventRecordCount: 0, rejectedRecordCount: 0 }]);
  const historicalCursor = { ...cursor, adapterVersion: dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion };
  await assert.rejects(fixture.source.nextPage(sourceInput({
    authority: fixture.captureAuthority,
    pageNumber: 2,
    checkpoint: historicalCursor,
    checkpointFingerprint: providerMixedCursorFingerprint(historicalCursor),
  })), (error: unknown) => error instanceof ProviderDataforrestSourceError
    && error.code === "PROVIDER_DATAFORREST_CURSOR_INVALID");
  assert.equal(fixture.requestedUrls.length, 1);
  const second = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({
    authority: fixture.captureAuthority,
    pageNumber: 2,
    checkpoint: first.nextCursor,
    checkpointFingerprint: first.nextCursorFingerprint,
  })));
  assert.equal(second.continuation, "head");
  assert.equal(fixture.requestedUrls[1]?.searchParams.get("cursor"), "collector-profile-next");
  assert.equal(fixture.requestedUrls[1]?.searchParams.get("limit"), "1000");
  assert.equal(fixture.terminalizations.every(({ operationScope }) =>
    operationScope.operationKind === "page_read" && operationScope.pageLimit === 1_000
    && operationScope.adapterVersion === manifest.adapterVersion), true);
});

test("Collector rejects 1,001 source records before translation without raising the 1,000-record request", async () => {
  const fixture = collectorSourceFixture([sourcePage({
    cursor: "collector-over-limit", continuation: "head", records: collectorPullRecords(1_001),
  })]);
  await assert.rejects(fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })),
    (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_INVALID_RESPONSE");
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "1000");
  assert.equal(fixture.terminalizations.length, 1);
  assert.equal(fixture.terminalizations[0]?.outcome.ok, true);
  assert.deepEqual(fixture.translations, []);
});

test("Collector retains the hard 8 MiB response guard at 1,000 records per request", async () => {
  const maximumResponseBytes = 8_388_608;
  assert.equal(dataforrestCollectorCryptDistributedSourceAdapterManifest.requestBounds.maximumResponseBytes, maximumResponseBytes);
  const fixture = collectorSourceFixture([sourcePage({
    cursor: "collector-over-byte-limit", continuation: "head",
    records: [{ ...collectorPullRecords(1)[0]!, data: { native_padding: "x".repeat(maximumResponseBytes) } }],
  })]);
  await assert.rejects(fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })),
    (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_RESPONSE_TOO_LARGE");
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "1000");
  assert.equal(fixture.terminalizations.length, 1);
  assert.equal(fixture.terminalizations[0]?.outcome.ok, false);
  assert.deepEqual(fixture.translations, []);
});

test("Collector-only profile rejects other providers before HTTP and historical 100-record pages remain readable", async () => {
  const current = dataforrestCollectorCryptDistributedSourceAdapterManifest;
  const fixture = collectorSourceFixture([]);
  for (const providerKey of ["courtyard", "clutchpacks", "phygitals"] as const) {
    assert.throws(() => createProviderDataforrestLiveIntegration(providerKey, current), /invalid/);
    await assert.rejects(fixture.source.nextPage(sourceInput({
      authority: { ...fixture.captureAuthority, providerKey },
    })), (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_AUTHORITY_INVALID");
  }
  assert.equal(fixture.requestedUrls.length, 0);
  const historical = collectorSourceFixture([sourcePage({
    cursor: "collector-historical-head", continuation: "head", records: collectorPullRecords(100),
  })], dataforrestLaunchDistributedSourceAdapterManifest);
  const page = validateProviderMixedPage(await historical.source.nextPage(sourceInput({
    authority: historical.captureAuthority,
  })));
  assert.equal(page.records.length, 100);
  assert.equal(historical.requestedUrls[0]?.searchParams.get("limit"), "100");
});

test("Collector profile upgrade preserves identical canonical record identity and content", async () => {
  const pages = [];
  for (const manifest of [
    dataforrestLaunchDistributedSourceAdapterManifest,
    dataforrestCollectorCryptDistributedSourceAdapterManifest,
  ]) {
    const fixture = collectorSourceFixture([sourcePage({
      cursor: "collector-identical-observation", continuation: "head", records: collectorPullRecords(1),
    })], manifest);
    pages.push(validateProviderMixedPage(await fixture.source.nextPage(sourceInput({
      authority: fixture.captureAuthority,
    }))));
  }
  assert.equal(pages[0]!.records[0]!.kind, "pull");
  assert.notEqual(pages[0]!.records[0]!.disposition, "quarantine");
  assert.deepEqual(pages[0]!.records, pages[1]!.records);
  assert.notDeepEqual(pages[0]!.nextCursor, pages[1]!.nextCursor);
});

async function phygitalsMixedPage(
  records: readonly DataforrestEventRecordV1[],
  manifest = dataforrestPhygitalsDistributedSourceAdapterManifest,
) {
  const integration = createProviderDataforrestLiveIntegration("phygitals", manifest);
  const fixture = sourceFixture({
    integration,
    resolvedAuthority: {
      ...resolvedAuthority,
      providerKey: "phygitals",
      adapterKey: manifest.adapterVersion,
      sourceAdapterVersion: manifest.adapterVersion,
      sourceConfiguration: { platform: "phygitals" },
    },
    pages: [sourcePage({ cursor: "phygitals-fixture-cursor", continuation: "continue", records })],
  });
  return validateProviderMixedPage(await fixture.source.nextPage(sourceInput({
    authority: {
      ...authority,
      providerKey: "phygitals",
      configuration: { adapterKey: manifest.adapterVersion, settings: {} },
    },
  })));
}

test("versioned Phygitals native cards reach valid collectibles without mapping quarantine", async () => {
  const page = await phygitalsMixedPage(["chase", "asset"].map((wrapper) =>
    phygitalsCardRecord(`envelope-${wrapper}`, { [wrapper]: {
      id: "nested-id-must-not-be-identity",
      name: `Reviewed ${wrapper} card`,
      image: "https://images.example.invalid/phygitals.png",
      fmv: 500, altFmv: 500, price: 500, currency: null,
      owner: actorMarker, address: rawMarker, metadata: { protected: rawMarker },
    } }),
  ));
  assert.equal(DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
    dataforrestPhygitalsDistributedSourceAdapterManifest.adapterVersion);
  assert.equal(page.records.length, 2);
  assert.equal(page.records.filter(({ disposition }) => disposition === "quarantine").length, 0);
  for (const wrapper of ["chase", "asset"]) {
    const record = page.records.find(({ candidate }) =>
      candidate.collectibleKey === `card:envelope-${wrapper}`);
    assert.ok(record);
    assert.equal(record.kind, "catalog");
    assert.equal(record.entityType, "collectible");
    assert.equal(record.candidate.collectibleKey, `card:envelope-${wrapper}`);
    assert.equal(record.candidate.displayName, `Reviewed ${wrapper} card`);
    assert.equal(record.candidate.valuationAmount, null);
    assert.equal(record.candidate.valuationCurrency, null);
    assert.equal(record.candidate.valuationType, null);
  }
  const serialized = JSON.stringify(page.records);
  for (const forbidden of [rawMarker, actorMarker, "nested-id-must-not-be-identity"])
    assert.equal(serialized.includes(forbidden), false);
});

test("Phygitals wrapper ambiguity and malformed names stay record-local quarantines", async () => {
  const page = await phygitalsMixedPage([
    phygitalsCardRecord("ambiguous", { chase: { name: "One" }, asset: { name: "Two" } }),
    phygitalsCardRecord("malformed", { asset: { name: 7 } }),
    phygitalsCardRecord("unknown", { name: "Do not infer", provider_label: "Do not fallback" }),
    phygitalsCardRecord("valid", { asset: { name: "Valid" } }),
  ]);
  assert.equal(page.records.length, 4);
  assert.equal(page.records.filter(({ disposition }) => disposition === "quarantine").length, 3);
  assert.equal(page.records.filter(({ disposition }) => disposition !== "quarantine").length, 1);
  assert.equal(page.records.filter(({ disposition }) => disposition === "quarantine")
    .every(({ reasonCode }) => reasonCode === "SOURCE_RECORD_MAPPING_INVALID"), true);
});

test("historical shared launch Phygitals normalization remains unchanged", async () => {
  const page = await phygitalsMixedPage([
    phygitalsCardRecord("old-chase", { chase: { name: "Nested chase" } }),
    phygitalsCardRecord("old-asset", { asset: { name: "Nested asset" } }),
  ], dataforrestLaunchDistributedSourceAdapterManifest);
  assert.equal(page.records.length, 2);
  assert.equal(page.records.every(({ disposition, reasonCode }) =>
    disposition === "quarantine" && reasonCode === "SOURCE_RECORD_MAPPING_INVALID"), true);
});

test("Phygitals V2 inventory and NFT wrappers preserve envelope identity with explicit label precedence", async () => {
  const page = await phygitalsMixedPage([
    phygitalsCardRecord("inventory-card", { inventory: { title: "Inventory Card", id: "native-id" },
      nft: { name: "Different NFT Card", image: "https://example.test/not-selected.png" } }),
    phygitalsCardRecord("nft-card", { nft: { name: "NFT Card", image: "https://example.test/selected.png" } }),
    phygitalsCardRecord("existing-asset", { asset: { name: "Original Asset" }, nft: { name: "Different label" } }),
  ], dataforrestPhygitalsDistributedV2SourceAdapterManifest);
  assert.equal(page.records.length, 3);
  assert.equal(page.records.some(({ disposition }) => disposition === "quarantine"), false);
  const byKey = new Map(page.records.map(({ candidate }) => [candidate.collectibleKey, candidate]));
  assert.equal(byKey.get("card:inventory-card")?.displayName, "Inventory Card");
  assert.equal(byKey.get("card:inventory-card")?.primaryImageUrl, null);
  assert.equal(byKey.get("card:nft-card")?.displayName, "NFT Card");
  assert.equal(byKey.get("card:nft-card")?.primaryImageUrl, "https://example.test/selected.png");
  assert.equal(byKey.get("card:existing-asset")?.displayName, "Original Asset");
  assert.equal(page.records.every(({ candidate }) => candidate.valuationAmount === null), true);
});

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

function courtyardNativeCard(recordId: string, data: DataforrestEventRecordV1["data"]): DataforrestEventRecordV1 {
  return { ...courtyardUnlabeledCard(), record_id: recordId, data };
}

function courtyardNativeFixture(
  pages: readonly DataforrestEventsPageV1[],
  manifest = dataforrestCourtyardDistributedSourceAdapterManifest,
) {
  return {
    ...sourceFixture({
      pages,
      integration: createProviderDataforrestLiveIntegration("courtyard", manifest),
      resolvedAuthority: {
        ...courtyardResolvedAuthority,
        adapterKey: manifest.adapterVersion,
        sourceAdapterVersion: manifest.adapterVersion,
      },
    }),
    captureAuthority: {
      ...courtyardAuthority,
      configuration: { adapterKey: manifest.adapterVersion, settings: {} },
    },
  };
}

test("versioned Courtyard native cards map reviewed wrappers and quarantine malformed or absent names", async () => {
  const invalidAssets: DataforrestEventRecordV1["data"][string][] = [
    null, [], { title: 42 }, { title: " " }, {},
  ];
  const fixture = courtyardNativeFixture([sourcePage({
    cursor: "courtyard-native-next", continuation: "continue", records: [
      courtyardNativeCard("native-asset", { asset: {
        title: "Asset title", imageUrl: "https://example.test/asset.png",
        objectID: "native-id-must-not-escape", owner: actorMarker,
        estimatedValueUsd: 500, price: { amountUsd: 500, currency: "USD" },
      } }),
      courtyardNativeCard("native-reveal", { reveal: {
        title: "Reveal title", image: "https://example.test/reveal.png",
        collectible_id: "native-id-must-not-escape", fmv_estimate_usd: 500,
      } }),
      courtyardNativeCard("native-precedence", {
        asset: { title: "Selected asset" },
        reveal: { title: "Unselected reveal", image: "https://example.test/not-selected.png" },
      }),
      courtyardNativeCard("native-unsafe-image", { asset: { title: "Safe name", imageUrl: "javascript:unsafe" } }),
      ...invalidAssets.map((asset, index) =>
        courtyardNativeCard(`native-invalid-${index}`, { asset, reveal: { title: "Do not fallback" } })),
      courtyardNativeCard("native-absent", {
        provider_label: "Do not infer", prices: { priceHistory: [{ title: rawMarker }] },
      }),
    ],
  })]);
  const page = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })));
  const accepted = page.records.filter(({ disposition }) => disposition !== "quarantine");
  const quarantines = page.records.filter(({ disposition }) => disposition === "quarantine");
  assert.equal(accepted.length, 4);
  assert.equal(quarantines.length, 6);
  assert.equal(quarantines.every(({ reasonCode }) => reasonCode === "SOURCE_RECORD_MAPPING_INVALID"), true);
  assert.deepEqual(accepted.map(({ candidate }) => candidate.displayName),
    ["Asset title", "Selected asset", "Reveal title", "Safe name"]);
  assert.deepEqual(accepted.map(({ candidate }) => candidate.collectibleKey),
    ["card:native-asset", "card:native-precedence", "card:native-reveal", "card:native-unsafe-image"]);
  for (const record of accepted) {
    assert.equal(record.entityType, "collectible");
    assert.equal(record.candidate.valuationAmount, null);
    assert.equal(record.candidate.valuationCurrency, null);
  }
  const serialized = JSON.stringify(page.records);
  for (const forbidden of ["native-id-must-not-escape", actorMarker, rawMarker,
    "Unselected reveal", "not-selected.png", "javascript:unsafe", "Do not fallback"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("Courtyard native profile requests 100 and enforces exact cursor tuple before continuation", async () => {
  const manifest = dataforrestCourtyardDistributedSourceAdapterManifest;
  const fixture = courtyardNativeFixture([
    sourcePage({ cursor: "courtyard-native-checkpoint", continuation: "continue",
      records: Array.from({ length: 100 }, (_, index) => courtyardNativeCard(`native-${index}`, {
        asset: { title: `Card ${index}` },
      })), }),
    sourcePage({ cursor: "courtyard-native-head", continuation: "head", records: [] }),
  ]);
  const first = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })));
  assert.equal(first.records.length, 100);
  assert.equal(first.records.every(({ disposition }) => disposition !== "quarantine"), true);
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "100");
  const cursor = first.nextCursor as Record<string, CanonicalJsonValue>;
  assert.equal(cursor.adapterVersion, manifest.adapterVersion);
  assert.equal(cursor.cursorCodecKey, manifest.cursorCodecKey);
  const crossedPins: Record<string, CanonicalJsonValue>[] = [
    { adapterVersion: dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion },
    { adapterVersion: dataforrestCollectorCryptDistributedSourceAdapterManifest.adapterVersion },
    { cursorCodecKey: "unsupported-codec" },
    { sourceRevisionId: "55555555-5555-4555-8555-555555555555" },
    { sourceInstanceId: "66666666-6666-4666-8666-666666666666" },
  ];
  for (const changed of crossedPins) {
    const crossed = { ...cursor, ...changed };
    await assert.rejects(fixture.source.nextPage(sourceInput({
      authority: fixture.captureAuthority, pageNumber: 2,
      checkpoint: crossed, checkpointFingerprint: providerMixedCursorFingerprint(crossed),
    })), (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_CURSOR_INVALID");
  }
  assert.equal(fixture.requestedUrls.length, 1);
  const second = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({
    authority: fixture.captureAuthority, pageNumber: 2,
    checkpoint: first.nextCursor, checkpointFingerprint: first.nextCursorFingerprint,
  })));
  assert.equal(second.continuation, "head");
  assert.equal(fixture.requestedUrls[1]?.searchParams.get("cursor"), "courtyard-native-checkpoint");
});

test("Courtyard native profile refuses 101 records and over-8-MiB bodies before translation", async () => {
  for (const [records, code] of [
    [Array.from({ length: 101 }, (_, index) => courtyardNativeCard(`over-count-${index}`, {
      asset: { title: "Card" },
    })), "PROVIDER_DATAFORREST_INVALID_RESPONSE"],
    [[courtyardNativeCard("over-bytes", { asset: { title: "Card" }, native_padding: "x".repeat(8_388_608) })],
      "PROVIDER_DATAFORREST_RESPONSE_TOO_LARGE"],
  ] as const) {
    const fixture = courtyardNativeFixture([sourcePage({ cursor: "rejected", continuation: "head", records })]);
    await assert.rejects(fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })),
      (error: unknown) => error instanceof ProviderDataforrestSourceError && error.code === code);
    assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "100");
    assert.equal(fixture.translations.length, 0);
  }
});

test("Courtyard v2 admits its exact larger body budget through capture, interpretation, native evidence and canonical validation", async () => {
  const manifest = dataforrestCourtyardDistributedV2SourceAdapterManifest;
  const paddedNative = { asset: { title: "Card 0" }, protected_padding: "" };
  const source = sourcePage({ cursor: "larger-budget-checkpoint", continuation: "continue",
    records: Array.from({ length: 100 }, (_, index) => courtyardNativeCard(`large-${index}`, index === 0 ? paddedNative : {
      asset: { title: `Card ${index}` }, protected_padding: "",
    })),
  });
  paddedNative.protected_padding = "x".repeat(manifest.requestBounds.maximumResponseBytes - Buffer.byteLength(JSON.stringify(source)));
  assert.equal(Buffer.byteLength(JSON.stringify(source)), manifest.requestBounds.maximumResponseBytes);
  const fixture = courtyardNativeFixture([source,
    sourcePage({ cursor: "larger-budget-head", continuation: "head", records: [] }),
  ], manifest);
  const first = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority })));
  assert.equal(first.records.length, 100);
  assert.equal(first.records.every((record) => record.disposition !== "quarantine" && record.entityType === "collectible"), true);
  assert.equal(fixture.requestedUrls[0]?.searchParams.get("limit"), "100");
  assert.equal(fixture.terminalizations[0]?.outcome.measurements.responseBytes, manifest.requestBounds.maximumResponseBytes);
  assert.equal(JSON.stringify(first.records).includes("protected_padding"), false);
  const cursor = first.nextCursor as Record<string, CanonicalJsonValue>;
  assert.equal(cursor.adapterVersion, manifest.adapterVersion);
  const crossed = { ...cursor, adapterVersion: dataforrestCourtyardDistributedSourceAdapterManifest.adapterVersion };
  await assert.rejects(fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority, pageNumber: 2,
    checkpoint: crossed, checkpointFingerprint: providerMixedCursorFingerprint(crossed),
  })), (error: unknown) => error instanceof ProviderDataforrestSourceError && error.code === "PROVIDER_DATAFORREST_CURSOR_INVALID");
  assert.equal(fixture.requestedUrls.length, 1);
  const second = validateProviderMixedPage(await fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority,
    pageNumber: 2, checkpoint: first.nextCursor, checkpointFingerprint: first.nextCursorFingerprint,
  })));
  assert.equal(second.continuation, "head");
  assert.equal(fixture.requestedUrls[1]?.searchParams.get("cursor"), "larger-budget-checkpoint");

  paddedNative.protected_padding += "x";
  const rejected = courtyardNativeFixture([source], manifest);
  await assert.rejects(rejected.source.nextPage(sourceInput({ authority: rejected.captureAuthority })),
    (error: unknown) => error instanceof ProviderDataforrestSourceError && error.code === "PROVIDER_DATAFORREST_RESPONSE_TOO_LARGE");
  assert.equal(rejected.translations.length, 0);
  assert.equal(rejected.terminalizations[0]?.outcome.measurements.responseBytes, 0);
  assert.deepEqual(rejected.terminalizations[0]?.outcome.diagnostics[1], {
    severity: "warning", phase: "request_capture", code: "response_too_large_streamed_body",
    counters: { maximum_response_bytes: manifest.requestBounds.maximumResponseBytes,
      reported_response_bytes: manifest.requestBounds.maximumResponseBytes + 1 },
  });
});

test("Courtyard native profile preserves canonical pull and event identity and historical card behavior", async () => {
  const pages = [];
  for (const manifest of [dataforrestLaunchDistributedSourceAdapterManifest, dataforrestCourtyardDistributedSourceAdapterManifest,
    dataforrestCourtyardDistributedV2SourceAdapterManifest]) {
    const fixture = courtyardNativeFixture([sourcePage({ cursor: "parity", continuation: "head",
      records: courtyardRecords().filter((record) => record.stream !== "catalog"),
    })], manifest);
    pages.push(validateProviderMixedPage(await fixture.source.nextPage(sourceInput({ authority: fixture.captureAuthority }))));
  }
  assert.deepEqual(pages[0]!.records, pages[1]!.records);
  assert.deepEqual(pages[1]!.records, pages[2]!.records);
  assert.equal(pages[1]!.records.some(({ kind }) => kind === "pull"), true);
  assert.equal(pages[1]!.records.some(({ kind }) => kind === "market_event"), true);
  const historical = courtyardNativeFixture([sourcePage({ cursor: "historical", continuation: "head", records: [
    courtyardNativeCard("historical-native", { asset: { title: "Still not interpreted under old profile" } }),
  ] })], dataforrestLaunchDistributedSourceAdapterManifest);
  const page = validateProviderMixedPage(await historical.source.nextPage(sourceInput({ authority: historical.captureAuthority })));
  assert.equal(page.records[0]?.disposition, "quarantine");
  assert.equal(page.records[0]?.reasonCode, "SOURCE_RECORD_MAPPING_INVALID");
});

test("historical Courtyard shared-launch mapping retains the 100-record manifest and unchanged 8 MiB cap", async () => {
  const integration = createProviderDataforrestLiveIntegration(
    "courtyard",
    dataforrestLaunchDistributedSourceAdapterManifest,
  );
  assert.equal(DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS, 100);
  assert.equal(
    integration.manifest.requestBounds.pageLimit,
    DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
  );
  assert.equal(
    integration.manifest.requestBounds.maximumResponseBytes,
    providerSourceLaunchBounds.maximumResponseBytes,
  );
  assert.equal(
    integration.manifest.requestBounds.maximumResponseBytes,
    8 * 1024 * 1024,
  );
  const fixture = sourceFixture({
    integration,
    resolvedAuthority: courtyardResolvedAuthority,
    workerId: "fixture:courtyard",
    pages: [
      sourcePage({
        cursor: "courtyard-cursor-001",
        continuation: "continue",
        records: [...courtyardRecords(), courtyardUnlabeledCard()],
      }),
      sourcePage({
        cursor: "courtyard-cursor-001",
        continuation: "head",
        records: [],
      }),
    ],
  });

  const first = validateProviderMixedPage(await fixture.source.nextPage(
    sourceInput({ authority: courtyardAuthority }),
  ));
  assert.equal(first.continuation, "more");
  assert.equal(first.records.length, 5);
  assert.equal(first.records.some((record) =>
    record.kind === "catalog"
    && record.entityType === "category"
  ), false);
  assert.equal(first.records.some((record) =>
    record.kind === "catalog"
    && record.entityType === "pack"
    && record.candidate.packKey === "pack:courtyard-pack-001"
    && record.candidate.displayName === "Courtyard Fixture Pack"
    && record.candidate.availability === "available"
  ), true);
  assert.equal(first.records.some((record) =>
    record.kind === "catalog"
    && record.entityType === "collectible"
    && record.candidate.collectibleKey === "card:courtyard-card-001"
    && record.candidate.displayName === "Courtyard Fixture Card"
  ), true);
  const pull = first.records.find((record) => record.kind === "pull");
  assert.ok(pull);
  assert.equal(pull.candidate.packKey, "pack:courtyard-pack-001");
  assert.equal(
    (pull.candidate.items as readonly Record<string, unknown>[])[0]
      ?.collectibleKey,
    "card:courtyard-card-001",
  );
  const event = first.records.find((record) => record.kind === "market_event");
  assert.ok(event);
  assert.equal(event.candidate.eventType, "sale");
  assert.equal(event.candidate.collectibleKey, "card:courtyard-card-001");
  assert.equal(event.candidate.amount, "12.5");
  assert.equal(event.candidate.currency, "USD");
  const quarantine = first.records.find(
    (record) => record.disposition === "quarantine",
  );
  assert.ok(quarantine);
  assert.equal(quarantine.kind, "catalog");
  assert.equal(quarantine.reasonCode, "SOURCE_RECORD_MAPPING_INVALID");
  assert.match(quarantine.sourceRecordKey ?? "", /^source:[a-f0-9]{64}$/u);
  assert.equal(first.records.some((record) =>
    record.kind === "catalog"
    && (record.entityType === "provider_account"
      || record.entityType === "pack_content")
  ), false);

  assert.deepEqual(first.nextCursor, {
    sourceInstanceId: providerId,
    sourceRevisionId: configVersionId,
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    adapterVersion: DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
    cursorCodecKey:
      dataforrestLaunchDistributedSourceAdapterManifest.cursorCodecKey,
    cursorGeneration: 1,
    value: "courtyard-cursor-001",
  });
  assert.equal(
    first.nextCursorFingerprint,
    providerMixedCursorFingerprint(first.nextCursor),
  );
  const second = validateProviderMixedPage(await fixture.source.nextPage(
    sourceInput({
      authority: courtyardAuthority,
      pageNumber: 2,
      checkpoint: first.nextCursor,
      checkpointFingerprint: first.nextCursorFingerprint,
    }),
  ));
  assert.equal(second.continuation, "head");
  assert.equal(
    fixture.requestedUrls[0]?.searchParams.get("limit"),
    String(integration.manifest.requestBounds.pageLimit),
  );
  assert.equal(
    fixture.requestedUrls[1]?.searchParams.get("cursor"),
    "courtyard-cursor-001",
  );
  assert.deepEqual(fixture.translations, [
    { sourceRecordCount: 5, normalizedRecordCount: 5 },
    { sourceRecordCount: 0, normalizedRecordCount: 0 },
  ]);
  assert.deepEqual(
    fixture.terminalizations.map(({ operationScope }) => {
      assert.equal(operationScope.operationKind, "page_read");
      if (operationScope.operationKind !== "page_read") {
        assert.fail("expected page-read operation");
      }
      return operationScope.pageLimit;
    }),
    [
      DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
      DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
    ],
  );
  assert.equal(fixture.terminalizations.every(({ operationScope }) =>
    operationScope.operationKind === "page_read"
    && operationScope.provider === "courtyard"
    && operationScope.adapterVersion ===
      DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION
    && operationScope.identityNamespaceKey === integration.mapper
      .identityNamespaceKey
    && operationScope.pageLimit === integration.manifest.requestBounds.pageLimit
  ), true);

  const foreignCursor = {
    ...(first.nextCursor as Record<string, unknown>),
    sourceRevisionId: "55555555-5555-4555-8555-555555555555",
  };
  await assert.rejects(
    fixture.source.nextPage(sourceInput({
      authority: courtyardAuthority,
      pageNumber: 3,
      checkpoint: foreignCursor,
      checkpointFingerprint: providerMixedCursorFingerprint(foreignCursor),
    })),
    (error: unknown) => error instanceof ProviderDataforrestSourceError
      && error.code === "PROVIDER_DATAFORREST_CURSOR_INVALID",
  );
  assert.equal(fixture.requestedUrls.length, 2);
  assert.equal(fixture.terminalizations.length, 2);
  const durableSurface = JSON.stringify(
    { first, second },
    (_key, value: unknown) => typeof value === "bigint"
      ? value.toString()
      : value,
  );
  assert.equal(durableSurface.includes(rawMarker), false);
  assert.equal(durableSurface.includes(actorMarker), false);
  assert.equal(durableSurface.includes("courtyard-transaction-must-not-escape"), false);
});

test("Courtyard live source rejects every nonmatching provider-adapter pair before authority or transport", async () => {
  const integration = createProviderDataforrestLiveIntegration(
    "courtyard",
    dataforrestLaunchDistributedSourceAdapterManifest,
  );
  let resolutions = 0;
  const fixture = sourceFixture({
    integration,
    resolvedAuthority: courtyardResolvedAuthority,
    resolver() {
      resolutions += 1;
      return Promise.resolve(courtyardResolvedAuthority);
    },
    pages: [sourcePage({
      cursor: "unused",
      continuation: "head",
      records: [],
    })],
  });
  const pairs = [
    ["courtyard", DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION],
    ["clutchpacks", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION],
    ["collector_crypt", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION],
    ["phygitals", DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION],
  ] as const;
  for (const [providerKey, adapterKey] of pairs) {
    assert.equal(fixture.source.supports(adapterKey, providerKey), false);
    await assert.rejects(
      fixture.source.nextPage(sourceInput({
        authority: {
          ...courtyardAuthority,
          providerKey,
          configuration: { adapterKey },
        },
      })),
      (error: unknown) => error instanceof ProviderDataforrestSourceError
        && error.code === "PROVIDER_DATAFORREST_AUTHORITY_INVALID",
    );
  }
  assert.equal(resolutions, 0);
  assert.equal(fixture.requestedUrls.length, 0);
  assert.equal(fixture.terminalizations.length, 0);
  assert.equal(fixture.translations.length, 0);
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
