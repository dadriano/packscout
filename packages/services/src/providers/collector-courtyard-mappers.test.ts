import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dataforrestEventRecordV1Schema,
  dataforrestEventRecordV2Schema,
  emptyNormalizedProviderFacts,
  launchProviderKeys,
  normalizeDataforrestEventRecordV2,
  normalizeDataforrestEventRecordV3,
  providerEventCodes,
} from "@packscout/contracts";
import {
  fingerprintCanonicalProviderCandidate,
  type CanonicalMarketEventCandidate,
  type CanonicalObservationPackCandidate,
  type CanonicalPullCandidate,
} from "../provider-observation-mapper.ts";
import { createProviderObservationMapperRegistryFromManifest } from "./provider-mapper-manifest.ts";
import {
  cardObservation,
  mapperInput,
  packFacts,
  packObservation,
  pullObservation,
  tradeObservation,
} from "./provider-observation-mapper.test-support.ts";

const registry = createProviderObservationMapperRegistryFromManifest();

function mapped(input: Parameters<typeof registry.map>[0]) {
  const outcome = registry.map(input);
  assert.equal(outcome.status, "mapped");
  if (outcome.status !== "mapped") throw new Error("expected mapped outcome");
  return outcome;
}

test("all four platform mappers project normalized pack, card, pull, and trade observations", () => {
  for (const provider of launchProviderKeys) {
    const pack = mapped(mapperInput(provider, packObservation()));
    const card = mapped(mapperInput(provider, cardObservation()));
    const pull = mapped(mapperInput(provider, pullObservation()));
    const trade = mapped(mapperInput(provider, tradeObservation()));

    assert.equal(pack.candidate.candidateKind, "pack");
    assert.equal(
      pack.candidate.candidateKind === "pack"
        ? pack.candidate.firstSeenAt
        : null,
      "2026-08-01T00:00:00.000Z",
    );
    assert.equal(card.candidate.candidateKind, "catalog_asset");
    assert.equal(
      card.candidate.candidateKind === "catalog_asset"
        ? card.candidate.assetType
        : null,
      "card",
    );
    assert.equal(pull.candidate.candidateKind, "pull");
    assert.equal(trade.candidate.candidateKind, "market_event");
    for (const outcome of [pack, card, pull, trade]) {
      assert.equal(outcome.candidate.identity.provider, provider);
      assert.equal(outcome.candidate.identity.providerId, "provider-" + provider);
      assert.equal(outcome.candidate.identity.organizationId, "org-task-005");
    }
  }
});

test("Collector Crypt native pack name reaches an accepted canonical pack", () => {
  const observation = normalizeDataforrestEventRecordV2(
    dataforrestEventRecordV1Schema.parse({
      platform: "collector_crypt",
      stream: "catalog",
      entity: "pack",
      record_id: "collector-pack-native-name",
      occurred_at: "2026-08-01T00:00:00.000Z",
      collected_at: "2026-08-01T00:00:01.000Z",
      first_seen_at: "2026-08-01T00:00:00.000Z",
      available: true,
      data: {
        name: "Collector Crypt Alpha",
        shortName: "Alpha",
        price: { amount: 99 },
      },
    }),
    "collector_crypt",
    "page_record:0",
  );
  const outcome = mapped(mapperInput("collector_crypt", observation));
  assert.equal(outcome.candidate.candidateKind, "pack");
  if (outcome.candidate.candidateKind !== "pack") {
    assert.fail("expected canonical pack candidate");
  }
  assert.equal(outcome.candidate.displayName, "Collector Crypt Alpha");
  assert.equal(
    outcome.candidate.identity.providerRecordId,
    "collector-pack-native-name",
  );
});

test("ClutchPacks native pack name reaches an accepted canonical pack", () => {
  const observation = normalizeDataforrestEventRecordV3(
    dataforrestEventRecordV2Schema.parse({
      platform: "clutchpacks",
      stream: "catalog",
      entity: "pack",
      record_id: "clutchpacks-pack-native-name",
      occurred_at: "2026-08-01T00:00:00.000Z",
      collected_at: "2026-08-01T00:00:01.000Z",
      first_seen_at: "2026-08-01T00:00:00.000Z",
      available: true,
      data: {
        name: "ClutchPacks Alpha",
        provider_label: "ignored provider label",
      },
    }),
    "clutchpacks",
    "page_record:0",
  );
  const outcome = mapped(mapperInput("clutchpacks", observation));
  assert.equal(outcome.candidate.candidateKind, "pack");
  if (outcome.candidate.candidateKind !== "pack") {
    assert.fail("expected canonical pack candidate");
  }
  assert.equal(outcome.candidate.displayName, "ClutchPacks Alpha");
  assert.equal(
    outcome.candidate.identity.providerRecordId,
    "clutchpacks-pack-native-name",
  );
});

test("availability has four non-overlapping states and sold out needs explicit authority", () => {
  const provider = "courtyard";
  for (const availability of [
    "available",
    "unavailable",
    "unknown",
  ] as const) {
    const outcome = mapped(
      mapperInput(
        provider,
        packObservation({
          availability,
          protectedNativeEvidenceRef: "native:sold-out-wording",
        }),
      ),
    );
    assert.equal(
      (outcome.candidate as CanonicalObservationPackCandidate).availability,
      availability,
    );
  }

  const soldOut = mapped(
    mapperInput(
      provider,
      packObservation({
        availability: "unavailable",
        providerFacts: packFacts({
          authoritativeAvailability: {
            state: "present",
            value: {
              state: "sold_out",
              authority: "provider_explicit_sold_out",
            },
          },
        }),
      }),
    ),
  );
  assert.equal(
    (soldOut.candidate as CanonicalObservationPackCandidate).availability,
    "sold_out",
  );

  const contradiction = registry.map(
    mapperInput(
      provider,
      packObservation({
        availability: "available",
        providerFacts: packFacts({
          authoritativeAvailability: {
            state: "present",
            value: {
              state: "sold_out",
              authority: "provider_explicit_sold_out",
            },
          },
        }),
      }),
    ),
  );
  assert.deepEqual(
    {
      status: contradiction.status,
      reason:
        contradiction.status === "quarantined"
          ? contradiction.reasonCode
          : null,
    },
    { status: "quarantined", reason: "availability_contradiction" },
  );

  const malformedAuthority = mapped(
    mapperInput(
      "clutchpacks",
      packObservation({
        availability: "unavailable",
        providerFacts: packFacts({
          authoritativeAvailability: { state: "malformed" },
        }),
      }),
    ),
  );
  assert.equal(
    (malformedAuthority.candidate as CanonicalObservationPackCandidate)
      .availability,
    "unavailable",
  );
  assert.deepEqual(malformedAuthority.warnings, [
    {
      code: "malformed_authoritative_availability",
      fieldPath: "providerFacts.authoritativeAvailability",
    },
  ]);
});

test("known and future event codes preserve nullable money, payment, and protected evidence", () => {
  for (const [index, eventType] of providerEventCodes.entries()) {
    const provider =
      eventType === "buyback"
        ? "phygitals"
        : eventType === "unlist"
          ? "collector_crypt"
          : launchProviderKeys[index % launchProviderKeys.length]!;
    const outcome = mapped(
      mapperInput(
        provider,
        tradeObservation({
          eventType,
          protectedNativeEvidenceRef:
            eventType === "buyback"
              ? "native:phygitals-buy"
              : eventType === "unlist"
                ? "native:collector-unlisted"
                : "native:event",
        }),
      ),
    );
    const candidate = outcome.candidate as CanonicalMarketEventCandidate;
    assert.equal(candidate.eventType, eventType);
    if (eventType === "buyback") {
      assert.equal(outcome.protectedNativeEvidenceRef, "native:phygitals-buy");
    }
    if (eventType === "unlist") {
      assert.equal(
        outcome.protectedNativeEvidenceRef,
        "native:collector-unlisted",
      );
    }
    assert.deepEqual(
      [candidate.amount, candidate.currency, candidate.paymentMethod],
      [null, null, null],
    );
    assert.equal(outcome.warnings.length, 0);
  }

  const future = mapped(
    mapperInput(
      "courtyard",
      tradeObservation({
        eventType: "auction_settled",
        amount: 12.5,
        currency: "USDC",
        paymentMethod: "partial_payment",
        protectedTransactionEvidenceRef: "transaction:chain-abc",
      }),
    ),
  );
  const event = future.candidate as CanonicalMarketEventCandidate;
  assert.equal(event.eventType, "auction_settled");
  assert.deepEqual(
    [event.amount, event.currency, event.paymentMethod],
    [12.5, "USDC", "partial_payment"],
  );
  assert.equal(future.protectedTransactionEvidenceRef, "transaction:chain-abc");
  assert.deepEqual(future.warnings, [
    { code: "future_event_code", fieldPath: "eventType" },
  ]);
  assert.equal(JSON.stringify(event).includes("transaction:chain-abc"), false);
});

test("a malformed currency ticker cannot cross the mapper boundary", () => {
  const validInput = mapperInput(
    "courtyard",
    tradeObservation({ amount: 12.5, currency: "USD" }),
  );
  const invalidInput = {
    ...validInput,
    observation: {
      ...validInput.observation,
      currency: "USD / not-a-ticker",
    } as typeof validInput.observation,
  };

  assert.throws(() => registry.map(invalidInput));
});

test("scope-qualified relationships keep equal raw IDs in distinct canonical kinds", () => {
  const normalizedPull = pullObservation();
  const outcome = mapped(mapperInput("courtyard", normalizedPull));
  const pull = outcome.candidate as CanonicalPullCandidate;
  assert.deepEqual(
    pull.relationships.map((relationship) => [
      relationship.targetProviderRecordId,
      relationship.targetRecordIdScopeKey,
      relationship.targetCanonicalKind,
    ]),
    [
      ["shared-raw-id", "catalog-pack-v1", "pack"],
      ["shared-raw-id", "catalog-card-v1", "catalog_asset"],
    ],
  );
  assert.equal(normalizedPull.kind, "pull");
  if (normalizedPull.kind !== "pull") return;
  const reversed = mapped(
    mapperInput(
      "courtyard",
      pullObservation({ relationships: [...normalizedPull.relationships].reverse() }),
    ),
  );
  assert.deepEqual(reversed.candidate, pull);
});

test("alternate-source provenance cannot change Courtyard business identity or content", () => {
  const fromDataForrest = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        collectedAt: "2026-08-20T12:00:01.000Z",
        protectedNativeEvidenceRef: "dataforrest:evidence-1",
      }),
    ),
  );
  const fromAlternate = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        collectedAt: "2026-08-21T12:00:01.000Z",
        protectedNativeEvidenceRef: "alternate:evidence-9",
      }),
    ),
  );
  assert.deepEqual(fromAlternate.candidate, fromDataForrest.candidate);
  assert.equal(
    fingerprintCanonicalProviderCandidate(fromAlternate.candidate),
    fingerprintCanonicalProviderCandidate(fromDataForrest.candidate),
  );
  assert.notEqual(
    fromAlternate.protectedNativeEvidenceRef,
    fromDataForrest.protectedNativeEvidenceRef,
  );
});

test("required pack name quarantines while malformed optional facts are bounded warnings", () => {
  const missingName = registry.map(
    mapperInput(
      "courtyard",
      packObservation({
        providerFacts: packFacts({ displayName: { state: "absent" } }),
      }),
    ),
  );
  assert.equal(missingName.status, "quarantined");
  assert.equal(
    missingName.status === "quarantined" ? missingName.reasonCode : null,
    "pack_display_name_required",
  );

  const optional = mapped(
    mapperInput(
      "collector_crypt",
      packObservation({
        providerFacts: packFacts({
          description: { state: "malformed" },
          category: { state: "malformed" },
          imageReferences: { state: "malformed" },
          price: { state: "malformed" },
          providerReportedEv: { state: "malformed" },
          buybackPercent: { state: "malformed" },
          drawCount: { state: "malformed" },
          evInput: { state: "malformed" },
        }),
      }),
    ),
  );
  const pack = optional.candidate as CanonicalObservationPackCandidate;
  assert.deepEqual(
    [
      pack.description,
      pack.category,
      pack.imageReferences,
      pack.price,
      pack.providerReportedEv,
      pack.buybackPercent,
      pack.drawCount,
    ],
    [null, null, [], null, null, null, null],
  );
  assert.equal(optional.warnings.length, 8);
  assert.equal(optional.evInputStatus, "unavailable");
});

test("optional card, pull, and trade display facts may be entirely absent", () => {
  const card = mapped(
    mapperInput(
      "collector_crypt",
      cardObservation({ providerFacts: emptyNormalizedProviderFacts("card") }),
    ),
  );
  const pull = mapped(mapperInput("phygitals", pullObservation()));
  const trade = mapped(mapperInput("clutchpacks", tradeObservation()));
  assert.equal(
    card.candidate.candidateKind === "catalog_asset"
      ? card.candidate.displayName
      : "wrong",
    null,
  );
  assert.deepEqual(card.evRecomputationImpact, {
    kind: "catalog_asset",
    affectedCatalogAsset: card.candidate.identity,
  });
  assert.equal(
    pull.candidate.candidateKind === "pull"
      ? pull.candidate.displayName
      : "wrong",
    null,
  );
  assert.equal(
    trade.candidate.candidateKind === "market_event"
      ? trade.candidate.displayName
      : "wrong",
    null,
  );
});
