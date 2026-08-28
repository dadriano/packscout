import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dataforestEventsV1EvidenceFixture } from "./__fixtures__/dataforest-events-v1.fixture.ts";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  dataforrestContinuation,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
  dataforrestEventsConnectionConfigurationV1Schema,
  dataforrestIdentityNamespaceByProvider,
  dataforrestNextCursor,
  dataforrestOpaqueCursorV1Schema,
  normalizeDataforrestEventRecord,
  normalizeDataforrestEventRecordForAdapter,
} from "./dataforrest-events-v1.ts";
import {
  normalizedProviderObservationPageSchema,
  normalizedProviderObservationSchema,
  normalizedObservationSemanticContent,
} from "./provider-source-observation-v1.ts";
import { emptyNormalizedProviderFacts } from "./provider-source-facts-v1.ts";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  launchProviderKeys,
  sourceAdapterFailureSchema,
  sourceAdapterSafeDiagnosticSchema,
} from "./provider-source-contract-v1.ts";

const cursorBase = {
  sourceInstanceId: "source-001",
  sourceRevisionId: "source-revision-001",
  sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  cursorCodecKey: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  cursorGeneration: 1,
  value: null,
} as const;

test("all sanitized DataForrest evidence pages parse and normalize in order", () => {
  for (const provider of launchProviderKeys) {
    const fixturePages = dataforestEventsV1EvidenceFixture[provider];
    for (const [pageName, raw] of Object.entries(fixturePages)) {
      const page = dataforrestEventsPageV1Schema.parse(raw);
      const outcomes = page.records.map((unknownRecord, recordIndex) => ({
        status: "valid" as const,
        recordIndex,
        observation: normalizeDataforrestEventRecord(
          dataforrestEventRecordV1Schema.parse(unknownRecord),
          provider,
          `fixture:${provider}:${pageName}:${recordIndex}`,
        ),
      }));
      const normalized = normalizedProviderObservationPageSchema.parse({
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
        provider,
        outcomes,
        nextCursor: dataforrestNextCursor(cursorBase, page),
        continuation: dataforrestContinuation(page),
        measurements: {
          durationMilliseconds: 1,
          responseBytes: 1,
          recordCount: page.records.length,
        },
        diagnostics: [],
      });
      assert.equal(normalized.outcomes.length, page.records.length);
      const trade = normalized.outcomes.find(
        (outcome) => outcome.status === "valid" && outcome.observation.kind === "trade",
      );
      if (trade?.status === "valid" && trade.observation.kind === "trade") {
        assert.equal(trade.observation.protectedTransactionEvidenceRef !== null, true);
        assert.equal(
          trade.observation.protectedTransactionEvidenceRef?.includes(
            String(page.records[trade.recordIndex]?.tx_hash ?? ""),
          ),
          false,
        );
      }
    }
  }
});

test("availability is three-state and false never invents sold_out", () => {
  const raw = dataforrestEventsPageV1Schema.parse(
    dataforestEventsV1EvidenceFixture.courtyard.continuation,
  );
  const observation = normalizeDataforrestEventRecord(
    dataforrestEventRecordV1Schema.parse(raw.records[0]!),
    "courtyard",
    "fixture:a",
  );
  assert.equal(observation.kind, "catalog");
  if (observation.kind !== "catalog") assert.fail("expected catalog observation");
  assert.equal(observation.availability, "unavailable");
  assert.equal(JSON.stringify(observation).includes("sold_out"), false);
  assert.equal(observation.providerFacts.kind, "pack");
  if (observation.providerFacts.kind !== "pack") {
    assert.fail("expected pack provider facts");
  }
  assert.deepEqual(observation.providerFacts.authoritativeAvailability, {
    state: "absent",
  });
});

test("DataForrest allowlists only the declared provider display-name field", () => {
  const raw = dataforrestEventRecordV1Schema.parse(
    dataforestEventsV1EvidenceFixture.courtyard.initial.records[0],
  );
  const expectedEmpty = emptyNormalizedProviderFacts("pack");
  const present = normalizeDataforrestEventRecord(
    { ...raw, data: { provider_label: "  Court Kings  ", hidden_price: 99 } },
    "courtyard",
    "fixture:facts-present",
  );
  assert.equal(present.kind, "catalog");
  if (present.kind !== "catalog") assert.fail("expected catalog observation");
  assert.deepEqual(present.providerFacts, {
    ...expectedEmpty,
    displayName: { state: "present", value: "Court Kings" },
  });
  assert.equal(JSON.stringify(present.providerFacts).includes("hidden_price"), false);

  for (const providerLabel of [" ", 42, {}, "a".repeat(10_001)]) {
    const malformed = normalizeDataforrestEventRecord(
      { ...raw, data: { provider_label: providerLabel, price: 12.5 } },
      "courtyard",
      "fixture:facts-malformed",
    );
    assert.equal(malformed.kind, "catalog");
    if (malformed.kind !== "catalog") {
      assert.fail("expected catalog observation");
    }
    assert.deepEqual(malformed.providerFacts, {
      ...expectedEmpty,
      displayName: { state: "malformed" },
    });
  }

  const absentData: Array<Record<string, string | null>> = [
    {},
    { provider_label: null, optional_value: "ignored" },
  ];
  for (const data of absentData) {
    const absent = normalizeDataforrestEventRecord(
      { ...raw, data },
      "courtyard",
      "fixture:facts-absent",
    );
    assert.equal(absent.kind, "catalog");
    if (absent.kind !== "catalog") assert.fail("expected catalog observation");
    assert.deepEqual(absent.providerFacts, expectedEmpty);
  }

});

test("Collector Crypt pack names normalize from the evidenced native name field", () => {
  const raw = dataforrestEventRecordV1Schema.parse({
    ...dataforestEventsV1EvidenceFixture.collector_crypt.initial.records[0],
    stream: "catalog",
    entity: "pack",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    available: true,
  });
  const expectedEmpty = emptyNormalizedProviderFacts("pack");
  const present = normalizeDataforrestEventRecord(
    {
      ...raw,
      data: {
        name: "  Collector Crypt Alpha  ",
        provider_label: "must not override the provider declaration",
        price: { amount: 99 },
      },
    },
    "collector_crypt",
    "fixture:collector-crypt-pack",
  );
  assert.equal(present.kind, "catalog");
  if (present.kind !== "catalog") assert.fail("expected catalog observation");
  assert.deepEqual(present.providerFacts, {
    ...expectedEmpty,
    displayName: { state: "present", value: "Collector Crypt Alpha" },
  });
  assert.equal(JSON.stringify(present.providerFacts).includes("99"), false);
  assert.equal(
    JSON.stringify(present.providerFacts).includes("must not override"),
    false,
  );

  for (const name of [" ", 42, {}, "a".repeat(10_001)]) {
    const malformed = normalizeDataforrestEventRecord(
      { ...raw, data: { name } },
      "collector_crypt",
      "fixture:collector-crypt-pack-malformed",
    );
    assert.equal(malformed.kind, "catalog");
    if (malformed.kind !== "catalog") {
      assert.fail("expected catalog observation");
    }
    assert.deepEqual(malformed.providerFacts, {
      ...expectedEmpty,
      displayName: { state: "malformed" },
    });
  }

  const absentData: Array<Record<string, string | null>> = [
    {},
    { name: null, provider_label: "ignored" },
  ];
  for (const data of absentData) {
    const absent = normalizeDataforrestEventRecord(
      { ...raw, data },
      "collector_crypt",
      "fixture:collector-crypt-pack-absent",
    );
    assert.equal(absent.kind, "catalog");
    if (absent.kind !== "catalog") assert.fail("expected catalog observation");
    assert.deepEqual(absent.providerFacts, expectedEmpty);
  }

});

test("Phygitals and ClutchPacks pack names use the native name field", () => {
  const fixtures = [
    {
      provider: "phygitals" as const,
      nativeName: "Phygitals Black Pack",
      legacyName: "Phygitals legacy label",
    },
    {
      provider: "clutchpacks" as const,
      nativeName: "ClutchPacks Alpha",
      legacyName: "ClutchPacks legacy label",
    },
  ];

  for (const fixture of fixtures) {
    const raw = dataforrestEventRecordV1Schema.parse({
      ...dataforestEventsV1EvidenceFixture[fixture.provider].initial.records[0],
      stream: "catalog",
      entity: "pack",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      available: true,
      data: {
        name: fixture.nativeName,
        provider_label: fixture.legacyName,
      },
    });
    if (raw.stream !== "catalog") assert.fail("expected catalog fixture");

    const observation = normalizeDataforrestEventRecord(
      raw,
      fixture.provider,
      `fixture:${fixture.provider}:pack-v1`,
    );
    assert.equal(observation.kind, "catalog");
    if (observation.kind !== "catalog") {
      assert.fail("expected catalog observation");
    }
    const expectedFacts = {
      ...emptyNormalizedProviderFacts("pack"),
      displayName: { state: "present", value: fixture.nativeName },
      ...(fixture.provider === "clutchpacks"
        ? { drawCount: { state: "present" as const, value: 1 } }
        : {}),
    };
    assert.deepEqual(observation.providerFacts, expectedFacts);

    const legacyLabelOnly = normalizeDataforrestEventRecord(
      { ...raw, data: { provider_label: fixture.legacyName } },
      fixture.provider,
      `fixture:${fixture.provider}:pack-v1-provider-label-only`,
    );
    assert.equal(legacyLabelOnly.kind, "catalog");
    if (legacyLabelOnly.kind !== "catalog") {
      assert.fail("expected catalog observation");
    }
    assert.deepEqual(
      legacyLabelOnly.providerFacts,
      fixture.provider === "clutchpacks"
        ? {
            ...emptyNormalizedProviderFacts("pack"),
            drawCount: { state: "present", value: 1 },
          }
        : emptyNormalizedProviderFacts("pack"),
    );
  }
});

test("ClutchPacks adapter v2 pack semantics remain reproducible under v3", () => {
  const raw = dataforrestEventRecordV1Schema.parse({
    platform: "clutchpacks",
    stream: "catalog",
    entity: "pack",
    record_id: "clutchpacks-pack-versioned",
    occurred_at: "2026-08-01T00:00:00.000Z",
    collected_at: "2026-08-01T00:00:01.000Z",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    available: true,
    data: {
      name: "Ascent",
      description: "One card per pack.",
      category: { name: "Sports" },
      price: {
        currency: { code: "USD", decimals: 2 },
        price_amount: "100",
      },
      image_url: "https://images.example.invalid/ascent.jpg",
      sold_out: false,
      price_bucket_odds: [{
        bucket_id: "base",
        name: "Base",
        min_price: "$20",
        max_price: "$99.99",
        drawable_count: 4,
      }],
    },
  });
  const v2 = normalizeDataforrestEventRecordForAdapter(
    raw,
    "clutchpacks",
    "fixture:clutchpacks-pack-v2",
    DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  );
  assert.equal(v2.kind, "catalog");
  if (v2.kind !== "catalog") assert.fail("expected v2 catalog observation");
  assert.deepEqual(v2.providerFacts, {
    ...emptyNormalizedProviderFacts("pack"),
    displayName: { state: "present", value: "Ascent" },
  });

  const v3 = normalizeDataforrestEventRecordForAdapter(
    raw,
    "clutchpacks",
    "fixture:clutchpacks-pack-v3",
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
  assert.equal(v3.kind, "catalog");
  if (v3.kind !== "catalog") assert.fail("expected v3 catalog observation");
  assert.equal(v3.providerFacts.kind, "pack");
  if (v3.providerFacts.kind !== "pack") {
    assert.fail("expected v3 pack provider facts");
  }
  assert.deepEqual(v3.providerFacts.description, {
    state: "present",
    value: "One card per pack.",
  });
  assert.equal(v3.providerFacts.evInput.state, "present");
});

test("ClutchPacks card facts normalize from the exact V1 asset allowlist", () => {
  const raw = dataforrestEventRecordV1Schema.parse({
    platform: "clutchpacks",
    stream: "catalog",
    entity: "card",
    record_id: "clutchpacks-card-one",
    occurred_at: "2026-08-01T00:00:00.000Z",
    collected_at: "2026-08-01T00:00:01.000Z",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    available: true,
    data: {
      asset: {
        card_id: "nested-context-id",
        title: "  2022 Select Courtside #1  ",
        name: "Subject name remains protected",
        type: "Sports",
        subtype: "  Basketball  ",
        year: 2022,
        set: "Protected Set Name",
        card_no: "1",
        description: "  Courtside parallel  ",
        formatted_current_price: " $1,234.50 ",
        front_image_url: " https://images.example.invalid/front.jpg ",
        front_image_medium_url: "https://images.example.invalid/front.jpg",
        front_image_thumbnail_url:
          "https://images.example.invalid/front-thumb.jpg",
        back_image_url: "https://images.example.invalid/back.jpg",
        back_image_medium_url: null,
        back_image_thumbnail_url:
          "https://images.example.invalid/back-thumb.jpg",
        certificate_no: "protected-certificate",
      },
      provider_label: "must not override the V1 asset title",
    },
  });
  const observation = normalizeDataforrestEventRecord(
    raw,
    "clutchpacks",
    "fixture:clutchpacks-card-v1",
  );
  assert.equal(observation.kind, "catalog");
  if (observation.kind !== "catalog") assert.fail("expected catalog observation");
  assert.deepEqual(observation.providerFacts, {
    ...emptyNormalizedProviderFacts("card"),
    displayName: { state: "present", value: "2022 Select Courtside #1" },
    description: { state: "present", value: "Courtside parallel" },
    category: { state: "present", value: "Basketball" },
    imageReferences: {
      state: "present",
      value: [
        "https://images.example.invalid/front.jpg",
        "https://images.example.invalid/front-thumb.jpg",
        "https://images.example.invalid/back.jpg",
        "https://images.example.invalid/back-thumb.jpg",
      ],
    },
    estimatedValue: {
      state: "present",
      value: { amount: 1_234.5, currency: "USD" },
    },
    valueSource: {
      state: "present",
      value: "clutchpacks_formatted_current_price",
    },
  });
  const factsJson = JSON.stringify(observation.providerFacts);
  for (const protectedValue of [
    "nested-context-id",
    "Subject name remains protected",
    "Protected Set Name",
    "protected-certificate",
    "must not override",
  ]) {
    assert.equal(factsJson.includes(protectedValue), false, protectedValue);
  }
  assert.equal(
    observation.providerRecordIdentity.providerRecordId,
    "clutchpacks-card-one",
  );

  const v2 = normalizeDataforrestEventRecordForAdapter(
    raw,
    "clutchpacks",
    "fixture:clutchpacks-card-v2",
    DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  );
  assert.equal(v2.kind, "catalog");
  if (v2.kind !== "catalog") assert.fail("expected v2 catalog observation");
  assert.deepEqual(v2.providerFacts, observation.providerFacts);

  const legacy = normalizeDataforrestEventRecordForAdapter(
    raw,
    "clutchpacks",
    "fixture:clutchpacks-card-legacy-v1",
    DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  );
  assert.equal(legacy.kind, "catalog");
  if (legacy.kind !== "catalog") assert.fail("expected legacy catalog observation");
  assert.deepEqual(
    legacy.providerFacts,
    {
      ...emptyNormalizedProviderFacts("card"),
      displayName: {
        state: "present",
        value: "must not override the V1 asset title",
      },
    },
  );
  assert.notEqual(
    JSON.stringify(legacy.providerFacts),
    JSON.stringify(observation.providerFacts),
  );
});

test("ClutchPacks card facts fail closed for malformed asset fields", () => {
  const base = dataforrestEventRecordV1Schema.parse({
    platform: "clutchpacks",
    stream: "catalog",
    entity: "card",
    record_id: "clutchpacks-card-malformed",
    occurred_at: "2026-08-01T00:00:00.000Z",
    collected_at: "2026-08-01T00:00:01.000Z",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    available: null,
    data: {},
  });
  const absent = normalizeDataforrestEventRecord(
    base,
    "clutchpacks",
    "fixture:clutchpacks-card-absent",
  );
  assert.equal(absent.kind, "catalog");
  if (absent.kind !== "catalog") assert.fail("expected catalog observation");
  assert.deepEqual(absent.providerFacts, emptyNormalizedProviderFacts("card"));

  const malformed = normalizeDataforrestEventRecord(
    {
      ...base,
      data: {
        asset: {
          title: " ",
          description: 42,
          subtype: {},
          formatted_current_price: "USD 10",
          front_image_url: 42,
        },
      },
    },
    "clutchpacks",
    "fixture:clutchpacks-card-malformed",
  );
  assert.equal(malformed.kind, "catalog");
  if (malformed.kind !== "catalog") assert.fail("expected catalog observation");
  assert.deepEqual(malformed.providerFacts, {
    ...emptyNormalizedProviderFacts("card"),
    displayName: { state: "malformed" },
    description: { state: "malformed" },
    category: { state: "malformed" },
    imageReferences: { state: "malformed" },
    estimatedValue: { state: "malformed" },
  });
});

test("raw IDs may repeat across evidenced scopes without aliasing", () => {
  const common = {
    platform: "courtyard" as const,
    record_id: "same-id",
    occurred_at: "2026-01-01T00:00:00.000Z",
    collected_at: "2026-01-01T00:00:01.000Z",
    data: {},
    first_seen_at: "2026-01-01T00:00:00.000Z",
    available: true,
  };
  const packRecord = dataforrestEventRecordV1Schema.parse(dataforrestEventsPageV1Schema.parse({
    records: [{ ...common, stream: "catalog", entity: "pack" }],
    next_cursor: "a",
    poll_after_seconds: 0,
  }).records[0]!);
  const cardRecord = dataforrestEventRecordV1Schema.parse(dataforrestEventsPageV1Schema.parse({
    records: [{ ...common, stream: "catalog", entity: "card" }],
    next_cursor: "a",
    poll_after_seconds: 0,
  }).records[0]!);
  const packObservation = normalizeDataforrestEventRecord(
    packRecord,
    "courtyard",
    "fixture:p",
  );
  const cardObservation = normalizeDataforrestEventRecord(
    cardRecord,
    "courtyard",
    "fixture:c",
  );
  assert.notEqual(
    packObservation.providerRecordIdentity.recordIdScopeKey,
    cardObservation.providerRecordIdentity.recordIdScopeKey,
  );
  assert.equal(
    packObservation.providerRecordIdentity.providerRecordId,
    cardObservation.providerRecordIdentity.providerRecordId,
  );
});

test("normalization rejects a record outside the immutable source provider", () => {
  const phygitalsRecord = dataforrestEventRecordV1Schema.parse(
    dataforestEventsV1EvidenceFixture.phygitals.initial.records[0],
  );
  assert.throws(
    () =>
      normalizeDataforrestEventRecord(
        phygitalsRecord,
        "courtyard",
        "fixture:wrong-provider",
      ),
    /dataforrest_events\.platform_mismatch/u,
  );
});

test("raw-valid trade currencies outside the ticker vocabulary fail normalization as ZodError", () => {
  const trade = dataforestEventsV1EvidenceFixture.courtyard.initial.records[3];
  for (const currency of ["usd", "$", `0x${"a".repeat(40)}`]) {
    const rawValid = dataforrestEventRecordV1Schema.parse({
      ...trade,
      currency,
    });
    assert.throws(
      () =>
        normalizeDataforrestEventRecord(
          rawValid,
          "courtyard",
          "fixture:trade-currency",
        ),
      (error: unknown) => error instanceof Error && error.name === "ZodError",
      currency,
    );
  }
});

test("DataForrest continuation accepts only the evidenced polling vocabulary", () => {
  const reachedHead = dataforrestEventsPageV1Schema.parse(
    dataforestEventsV1EvidenceFixture.courtyard.reachedHead,
  );
  assert.deepEqual(dataforrestContinuation(reachedHead), {
    kind: "poll_after",
    minimumDelaySeconds: 60,
  });
  assert.deepEqual(
    dataforrestContinuation({ ...reachedHead, records: [], poll_after_seconds: 0 }),
    { kind: "continue" },
  );
  assert.equal(
    dataforrestEventsPageV1Schema.safeParse({
      ...reachedHead,
      records: reachedHead.records,
      poll_after_seconds: 1,
    }).success,
    false,
  );
});

test("DataForrest requires an evidenced cursor and permits a missing transaction hash", () => {
  const trade = dataforestEventsV1EvidenceFixture.courtyard.initial.records[3];
  assert.equal(
    dataforrestEventsPageV1Schema.safeParse({
      records: [trade],
      next_cursor: null,
      poll_after_seconds: 0,
    }).success,
    false,
  );
  const withoutTransactionHash = dataforrestEventRecordV1Schema.parse({
    ...trade,
    tx_hash: null,
  });
  const normalized = normalizeDataforrestEventRecord(
    withoutTransactionHash,
    "courtyard",
    "fixture:trade-without-transaction",
  );
  assert.equal(normalized.kind, "trade");
  if (normalized.kind !== "trade") assert.fail("expected trade observation");
  assert.equal(normalized.protectedTransactionEvidenceRef, null);
  for (const cursor of ["", " ", "\t", "\r\n"]) {
    assert.equal(
      dataforrestEventsPageV1Schema.safeParse({
        records: [],
        next_cursor: cursor,
        poll_after_seconds: 60,
      }).success,
      false,
    );
  }
  const exactCursor = "é".repeat(8_192);
  assert.equal(dataforrestOpaqueCursorV1Schema.safeParse(" \t ").success, false);
  assert.equal(dataforrestOpaqueCursorV1Schema.safeParse(exactCursor).success, true);
  assert.equal(
    dataforrestOpaqueCursorV1Schema.safeParse(`${exactCursor}a`).success,
    false,
  );
  assert.equal(dataforrestEventsPageV1Schema.safeParse({
    records: [],
    next_cursor: exactCursor,
    poll_after_seconds: 60,
  }).success, true);
  assert.equal(dataforrestEventsPageV1Schema.safeParse({
    records: [],
    next_cursor: `${exactCursor}a`,
    poll_after_seconds: 60,
  }).success, false);
});

test("connection configuration validates bearer authentication without safe-manifest exposure", () => {
  const configuration = dataforrestEventsConnectionConfigurationV1Schema.parse({
    endpoint: "https://198.204.245.26.sslip.io/v1/events",
    bearerToken: "fixture-secret-never-logged",
  });
  assert.equal(configuration.bearerToken.length > 0, true);
  assert.equal(
    dataforrestEventsConnectionConfigurationV1Schema.safeParse({
      ...configuration,
      bearerToken: "bad\r\nheader",
    }).success,
    false,
  );
  for (const bearerToken of [" token", "token ", "token\0suffix", "\t"]) {
    assert.equal(
      dataforrestEventsConnectionConfigurationV1Schema.safeParse({
        ...configuration,
        bearerToken,
      }).success,
      false,
    );
  }
});

test("one malformed record does not invalidate siblings and future codes stay bounded", () => {
  const trade = dataforestEventsV1EvidenceFixture.courtyard.initial.records[3];
  const page = dataforrestEventsPageV1Schema.parse({
    records: [trade, { malformed: true }, { ...trade, event_type: "future_code" }],
    next_cursor: "cursor",
    poll_after_seconds: 0,
  });
  assert.equal(page.records.length, 3);
  assert.equal(dataforrestEventRecordV1Schema.safeParse(page.records[1]).success, false);
  const future = dataforrestEventRecordV1Schema.parse(page.records[2]);
  const normalized = normalizeDataforrestEventRecord(
    future,
    "courtyard",
    "fixture:future",
  );
  assert.equal(normalized.kind, "trade");
  if (normalized.kind !== "trade") assert.fail("expected trade observation");
  assert.equal(normalized.eventType, "future_code");
});

test("an alternate vendor wrapper reaches the same generic observation contract", () => {
  const alternate = {
    items: [{
      category: "catalog" as const,
      subject: "pack" as const,
      id: "alternate-pack-001",
      effective: "2026-01-01T00:00:00.000Z",
      observed: "2026-01-01T00:00:01.000Z",
      inStock: null,
    }],
    next: {
      bookmark: "alternate-bookmark-001",
      state: "idle" as const,
      retryInSeconds: 60,
    },
  };
  const observation = normalizedProviderObservationSchema.parse({
    kind: alternate.items[0].category,
    entity: alternate.items[0].subject,
    providerRecordIdentity: {
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: alternate.items[0].id,
    },
    effectiveAt: alternate.items[0].effective,
    collectedAt: alternate.items[0].observed,
    firstSeenAt: alternate.items[0].effective,
    availability: "unknown",
    providerFacts: {
      ...emptyNormalizedProviderFacts("pack"),
      displayName: { state: "absent" },
    },
    relationships: [],
    protectedNativeEvidenceRef: "alternate:page:0",
  });
  const normalizedPage = normalizedProviderObservationPageSchema.parse({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider: "courtyard",
    outcomes: [{ status: "valid", recordIndex: 0, observation }],
    nextCursor: {
      sourceInstanceId: "alternate-source-001",
      sourceRevisionId: "alternate-source-revision-001",
      sourceTypeKey: "alternate-bookmark-v1",
      adapterVersion: "alternate-bookmark-adapter-v1",
      cursorCodecKey: "alternate-bookmark-codec-v1",
      cursorGeneration: 1,
      value: alternate.next.bookmark,
    },
    continuation: {
      kind: "poll_after",
      minimumDelaySeconds: alternate.next.retryInSeconds,
    },
    measurements: {
      durationMilliseconds: 3,
      responseBytes: 200,
      recordCount: 1,
    },
    diagnostics: [{
      severity: "info",
      phase: "alternate_capture",
      code: "alternate_page_valid",
      counters: { records: 1 },
    }],
  });
  const retryableFailure = sourceAdapterFailureSchema.parse({
    disposition: "retryable",
    code: "server_failure",
    retryAfterSeconds: 60,
    safeStatus: 503,
  });
  const safeDiagnostic = sourceAdapterSafeDiagnosticSchema.parse({
    severity: "warning",
    phase: "alternate_request",
    code: "alternate_busy",
    counters: { attempts: 1 },
  });

  assert.equal(normalizedPage.outcomes[0]?.status, "valid");
  assert.equal(normalizedPage.nextCursor.value, "alternate-bookmark-001");
  assert.deepEqual(normalizedPage.continuation, {
    kind: "poll_after",
    minimumDelaySeconds: 60,
  });
  assert.equal(retryableFailure.code, "server_failure");
  assert.equal(safeDiagnostic.code, "alternate_busy");
  assert.equal(dataforrestIdentityNamespaceByProvider.courtyard.startsWith("dataforrest-"), true);
  assert.equal("items" in normalizedPage, false);
  assert.equal("bookmark" in normalizedPage, false);
  assert.equal("next" in normalizedPage, false);
});

test("collection and protected evidence lineage cannot change semantic content", () => {
  const trade = dataforrestEventRecordV1Schema.parse(
    dataforestEventsV1EvidenceFixture.courtyard.initial.records[3],
  );
  const first = normalizeDataforrestEventRecord(
    trade,
    "courtyard",
    "fixture:page-a:3",
  );
  const replay = normalizeDataforrestEventRecord(
    { ...trade, collected_at: "2026-01-04T00:00:01.000Z" },
    "courtyard",
    "fixture:page-b:7",
  );
  assert.deepEqual(
    normalizedObservationSemanticContent(first),
    normalizedObservationSemanticContent(replay),
  );
  assert.notEqual(first.collectedAt, replay.collectedAt);
  assert.notEqual(
    first.protectedNativeEvidenceRef,
    replay.protectedNativeEvidenceRef,
  );
});

test("normalized page measurements cannot disagree with durable outcomes", () => {
  const page = normalizedProviderObservationPageSchema.parse({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider: "courtyard",
    outcomes: [],
    nextCursor: { ...cursorBase, value: "fixture-cursor" },
    continuation: { kind: "poll_after", minimumDelaySeconds: 60 },
    measurements: {
      durationMilliseconds: 1,
      responseBytes: 2,
      recordCount: 0,
    },
    diagnostics: [],
  });
  assert.equal(page.measurements.recordCount, page.outcomes.length);
  assert.equal(
    normalizedProviderObservationPageSchema.safeParse({
      ...page,
      measurements: { ...page.measurements, recordCount: 1 },
    }).success,
    false,
  );
});

test("DataForrest wrapper vocabulary is absent from generic contract modules", async () => {
  for (const fileName of [
    "provider-source-contract-v1.ts",
    "provider-source-observation-v1.ts",
  ]) {
    const source = await readFile(new URL(fileName, import.meta.url), "utf8");
    assert.equal(/next_cursor|poll_after_seconds|tx_hash/u.test(source), false);
  }
});

test("DataForrest v1 accepts either one-sided pull and canonicalizes relationships", () => {
  const pullBase = {
    stream: "pulls" as const,
    platform: "clutchpacks" as const,
    record_id: "pull-42",
    occurred_at: "2026-08-20T12:00:00.000Z",
    collected_at: "2026-08-20T12:00:01.000Z",
    data: {},
    pack_id: null,
    card_id: "card-42",
  };
  for (const { raw, expected } of [
    { raw: pullBase, expected: ["card"] },
    {
      raw: { ...pullBase, pack_id: "pack-42", card_id: null },
      expected: ["pack"],
    },
    {
      raw: { ...pullBase, pack_id: "pack-42" },
      expected: ["pack", "card"],
    },
  ] as const) {
    const parsed = dataforrestEventRecordV1Schema.parse(raw);
    const observation = normalizeDataforrestEventRecord(
      parsed,
      "clutchpacks",
      "page_record:0",
    );
    assert.equal(observation.kind, "pull");
    assert.deepEqual(
      observation.relationships.map(({ relationship }) => relationship),
      expected,
    );
  }
});

test("DataForrest v1 requires both pull keys and at least one relationship", () => {
  const fullyRelated = {
    stream: "pulls" as const,
    platform: "clutchpacks" as const,
    record_id: "pull-42",
    occurred_at: "2026-08-20T12:00:00.000Z",
    collected_at: "2026-08-20T12:00:01.000Z",
    data: {},
    pack_id: "pack-42",
    card_id: "card-42",
  };
  const { card_id: removedCardId, ...withoutCard } = fullyRelated;
  const { pack_id: removedPackId, ...withoutPack } = fullyRelated;
  assert.equal(removedCardId, "card-42");
  assert.equal(removedPackId, "pack-42");
  for (const invalid of [
    withoutCard,
    withoutPack,
    { ...fullyRelated, pack_id: null, card_id: null },
    { ...fullyRelated, card_id: "" },
    { ...fullyRelated, pack_id: "", card_id: null },
  ]) {
    assert.equal(dataforrestEventRecordV1Schema.safeParse(invalid).success, false);
  }
});
