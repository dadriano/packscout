import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";
import { DataReleaseV3CanonicalSourceError } from "./data-release-v3-canonical-catalog-adapter.ts";
import { PrismaClutchpacksCanonicalV3BuybackEvObservationRepository } from "./clutchpacks-canonical-v3-buyback-ev-observation-repository.ts";

const ORGANIZATION_ID = "71000000-0000-4000-8000-000000000001";
const READ_AT = "2026-08-27T19:20:44.000Z";

function sqlText(query: Prisma.Sql): string {
  return query.strings.join("?");
}

function fixtureClient(input: {
  settledAt?: Date;
  row?: Record<string, unknown>;
}) {
  const queries: Prisma.Sql[] = [];
  const responses: unknown[] = [
    [{
      settledSequence: 200n,
      settledAt: input.settledAt ?? new Date(READ_AT),
    }],
    [{ throughSequence: 190n }],
    input.row === undefined ? [] : [input.row],
  ];
  const database = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query);
      return responses.shift();
    },
  } as unknown as PackscoutPrismaClient;
  return { database, queries };
}

function observationRow(): Record<string, unknown> {
  return {
    productKey: "72000000-0000-4000-8000-000000000001",
    productRevisionId: "72000000-0000-4000-8000-000000000002",
    canonicalContentHash: "a".repeat(64),
    canonicalProvenanceHash: "b".repeat(64),
    canonicalPublicChangeSequence: 180n,
    evInputStatus: "ready",
    evInputRevisionId: "72000000-0000-4000-8000-000000000008",
    evInputCanonicalContentHash: "e".repeat(64),
    evInputCanonicalProvenanceHash: "f".repeat(64),
    evInputCanonicalPublicChangeSequence: 181n,
    providerId: "72000000-0000-4000-8000-000000000003",
    originSemanticObservationId: "72000000-0000-4000-8000-000000000004",
    semanticObservationId: "72000000-0000-4000-8000-000000000004",
    sourceRecordId: "72000000-0000-4000-8000-000000000005",
    providerRecordId: "72000000-0000-4000-8000-000000000001",
    normalizedContentHash: "c".repeat(64),
    hashVersion: "packscout.provider-observation-hash.v1",
    normalizedContent: { kind: "catalog" },
    effectiveSourceTime: new Date("2026-08-27T18:49:00.000Z"),
    deliveryOccurrenceId: 43368n,
    collectedAt: new Date("2026-08-27T18:50:36.000Z"),
    providerSourceRevisionId: "72000000-0000-4000-8000-000000000006",
    sourceInstanceId: "72000000-0000-4000-8000-000000000007",
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-events-adapter-v3",
    normalizedContractVersion: "packscout.provider-observation.v1",
    mapperKey: "clutchpacks-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
    cursorCodecVersion: "dataforrest-cursor-v1",
    configurationHash: "d".repeat(64),
  };
}

const CAUSAL_OCCURRENCE_FENCE_PATTERNS = [
  /join public\.import_pages as occurrence_page/u,
  /occurrence_page\.id = occurrence\.page_id/u,
  /occurrence_page\.organization_id = occurrence\.organization_id/u,
  /occurrence_page\.provider_id = occurrence\.provider_id/u,
  /occurrence_page\.run_id = occurrence\.run_id/u,
  /occurrence_page\.source_instance_id = occurrence\.source_instance_id/u,
  /occurrence_page\.source_revision_id = occurrence\.source_revision_id/u,
  /occurrence_page\.request_attempt_id = occurrence\.request_attempt_id/u,
  /occurrence_page\.source_type_key = occurrence\.source_type_key/u,
  /occurrence_page\.source_adapter_version =\s*occurrence\.source_adapter_version/u,
  /occurrence_page\.normalized_contract_version =\s*occurrence\.normalized_contract_version/u,
  /occurrence_page\.mapper_key = occurrence\.mapper_key/u,
  /occurrence_page\.mapper_version = occurrence\.mapper_version/u,
  /occurrence_page\.identity_namespace_key =\s*occurrence\.identity_namespace_key/u,
  /occurrence_page\.connection_profile_id =\s*occurrence\.connection_profile_id/u,
  /occurrence_page\.connection_revision_id =\s*occurrence\.connection_revision_id/u,
  /occurrence_page\.supervisor_epoch_id = occurrence\.supervisor_epoch_id/u,
  /occurrence_page\.cursor_codec_version =\s*occurrence\.cursor_codec_version/u,
  /occurrence_page\.cursor_generation = occurrence\.cursor_generation/u,
  /occurrence_page\.connection_health_generation =\s*occurrence\.connection_health_generation/u,
  /occurrence_page\.committed_at <=/u,
  /occurrence\.created_at <=/u,
] as const;

function hasCausalOccurrenceFence(query: Prisma.Sql): boolean {
  const text = sqlText(query);
  return CAUSAL_OCCURRENCE_FENCE_PATTERNS.every((pattern) =>
    pattern.test(text)
  );
}

test("ClutchPacks canonical V3 repository projects coherent normalized evidence and delivery freshness", async () => {
  const fixture = fixtureClient({ row: observationRow() });
  const repository =
    new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
      fixture.database,
      ORGANIZATION_ID,
    );
  const snapshot = await repository.loadSnapshot({ readAt: READ_AT });
  assert.equal(snapshot.organizationId, ORGANIZATION_ID);
  assert.equal(snapshot.providerId, "72000000-0000-4000-8000-000000000003");
  assert.equal(snapshot.throughSequence, "190");
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0]?.evInputStatus, "ready");
  assert.equal(snapshot.products[0]?.observation?.deliveryOccurrenceId, "43368");
  assert.deepEqual(snapshot.products[0]?.evInputRevision, {
    revisionId: "72000000-0000-4000-8000-000000000008",
    canonicalContentHash: "e".repeat(64),
    canonicalProvenanceHash: "f".repeat(64),
    canonicalPublicChangeSequence: "181",
  });
  assert.equal(
    snapshot.products[0]?.observation?.collectedAt,
    "2026-08-27T18:50:36.000Z",
  );

  assert.equal(fixture.queries.length, 3);
  const evidenceQuery = sqlText(fixture.queries[2]!);
  assert.match(evidenceQuery, /entity\.record_kind = 'ev_input'/u);
  assert.match(
    evidenceQuery,
    /governed_ev_inputs as \([\s\S]*entity\.record_kind = 'ev_input'[\s\S]*revision\.public_change_sequence <=[\s\S]*order by entity\.id,\s*revision\.public_change_sequence desc,\s*revision\.revision_number desc/u,
  );
  assert.match(
    evidenceQuery,
    /on ev_input\."productKey" = governed\."productKey"/u,
  );
  assert.match(
    evidenceQuery,
    /and governed\."evInputStatus" = 'ready'/u,
  );
  assert.match(
    evidenceQuery,
    /origin\.id = governed\."packOriginSemanticObservationId"/u,
  );
  assert.doesNotMatch(
    evidenceQuery,
    /origin\.id = ev_input\."originSemanticObservationId"/u,
  );
  assert.match(
    evidenceQuery,
    /revision\.origin_semantic_observation_id as\s*"packOriginSemanticObservationId"/u,
  );
  assert.match(evidenceQuery, /source_semantic_observations/u);
  assert.match(evidenceQuery, /source_delivery_occurrences/u);
  assert.doesNotMatch(
    evidenceQuery,
    /semantic\.normalized_content_json\s*=\s*origin\.normalized_content_json/u,
  );
  assert.match(
    evidenceQuery,
    /semantic\.source_record_id = origin\.source_record_id/u,
  );
  assert.match(
    evidenceQuery,
    /semantic\.normalized_contract_version =\s*origin\.normalized_contract_version/u,
  );
  assert.match(evidenceQuery, /semantic\.hash_version = origin\.hash_version/u);
  assert.match(evidenceQuery, /occurrence\.collected_at <=/u);
  for (const pattern of CAUSAL_OCCURRENCE_FENCE_PATTERNS) {
    assert.match(evidenceQuery, pattern);
  }
  assert.match(
    evidenceQuery,
    /semantic\.effective_source_time desc,[\s\S]*occurrence\.collected_at desc,[\s\S]*occurrence\.id desc/u,
  );
  assert.doesNotMatch(evidenceQuery, /payload_json/u);
  assert.doesNotMatch(evidenceQuery, /provider_config_revisions/u);
});

test("ClutchPacks canonical V3 repository advances governed EV facts independently of the pack revision", async () => {
  const firstRow = {
    ...observationRow(),
    normalizedContent: {
      kind: "catalog",
      effectiveAt: "2026-08-27T18:49:00.000Z",
      providerFacts: { evInput: { state: "present", value: { totalQuantity: 4 } } },
    },
  };
  const advancedRow = {
    ...firstRow,
    evInputRevisionId: "72000000-0000-4000-8000-000000000009",
    evInputCanonicalContentHash: "1".repeat(64),
    evInputCanonicalProvenanceHash: "2".repeat(64),
    evInputCanonicalPublicChangeSequence: 189n,
    originSemanticObservationId: "72000000-0000-4000-8000-000000000010",
    semanticObservationId: "72000000-0000-4000-8000-000000000010",
    normalizedContentHash: "3".repeat(64),
    normalizedContent: {
      kind: "catalog",
      effectiveAt: "2026-08-27T19:18:00.000Z",
      providerFacts: { evInput: { state: "present", value: { totalQuantity: 5 } } },
    },
    effectiveSourceTime: new Date("2026-08-27T19:18:00.000Z"),
    deliveryOccurrenceId: 43370n,
    collectedAt: new Date("2026-08-27T19:19:00.000Z"),
  };
  const firstFixture = fixtureClient({ row: firstRow });
  const advancedFixture = fixtureClient({ row: advancedRow });

  const first = await new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
    firstFixture.database,
    ORGANIZATION_ID,
  ).loadSnapshot({ readAt: READ_AT });
  const advanced = await new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
    advancedFixture.database,
    ORGANIZATION_ID,
  ).loadSnapshot({ readAt: READ_AT });

  assert.equal(
    advanced.products[0]?.productRevisionId,
    first.products[0]?.productRevisionId,
  );
  assert.equal(
    advanced.products[0]?.canonicalContentHash,
    first.products[0]?.canonicalContentHash,
  );
  assert.equal(
    first.products[0]?.evInputRevision?.revisionId,
    "72000000-0000-4000-8000-000000000008",
  );
  assert.equal(
    advanced.products[0]?.evInputRevision?.revisionId,
    "72000000-0000-4000-8000-000000000009",
  );
  assert.equal(
    advanced.products[0]?.observation?.originSemanticObservationId,
    "72000000-0000-4000-8000-000000000010",
  );
  assert.deepEqual(
    advanced.products[0]?.observation?.normalizedContent,
    advancedRow.normalizedContent,
  );
});

test("ClutchPacks canonical V3 repository advances a price-only pack revision without replacing governed EV input", async () => {
  const firstRow = observationRow();
  const advancedRow = {
    ...firstRow,
    productRevisionId: "72000000-0000-4000-8000-000000000011",
    canonicalContentHash: "4".repeat(64),
    canonicalProvenanceHash: "5".repeat(64),
    canonicalPublicChangeSequence: 189n,
    originSemanticObservationId: "72000000-0000-4000-8000-000000000012",
    semanticObservationId: "72000000-0000-4000-8000-000000000012",
    normalizedContentHash: "6".repeat(64),
    normalizedContent: {
      kind: "catalog",
      providerFacts: { price: { state: "present", value: { amount: 125 } } },
    },
    effectiveSourceTime: new Date("2026-08-27T19:18:00.000Z"),
    deliveryOccurrenceId: 43371n,
    collectedAt: new Date("2026-08-27T19:19:00.000Z"),
  };
  const first = await new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
    fixtureClient({ row: firstRow }).database,
    ORGANIZATION_ID,
  ).loadSnapshot({ readAt: READ_AT });
  const advanced = await new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
    fixtureClient({ row: advancedRow }).database,
    ORGANIZATION_ID,
  ).loadSnapshot({ readAt: READ_AT });

  assert.notEqual(
    advanced.products[0]?.productRevisionId,
    first.products[0]?.productRevisionId,
  );
  assert.deepEqual(
    advanced.products[0]?.evInputRevision,
    first.products[0]?.evInputRevision,
  );
  assert.equal(
    advanced.products[0]?.observation?.semanticObservationId,
    "72000000-0000-4000-8000-000000000012",
  );
});

test("ClutchPacks canonical V3 repository ignores historical EV input when the current pack is unavailable", async () => {
  const row = {
    ...observationRow(),
    evInputStatus: "unavailable",
    evInputRevisionId: null,
    evInputCanonicalContentHash: null,
    evInputCanonicalProvenanceHash: null,
    evInputCanonicalPublicChangeSequence: null,
    normalizedContent: {
      kind: "catalog",
      providerFacts: {
        evInput: {
          state: "present",
          value: { totalQuantity: 3, buckets: [{ quantity: 2 }] },
        },
      },
    },
  };
  const fixture = fixtureClient({ row });
  const snapshot = await new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
    fixture.database,
    ORGANIZATION_ID,
  ).loadSnapshot({ readAt: READ_AT });

  assert.equal(snapshot.products[0]?.evInputStatus, "unavailable");
  assert.equal(snapshot.products[0]?.evInputRevision, null);
  assert.notEqual(snapshot.products[0]?.observation, null);
  assert.match(
    sqlText(fixture.queries[2]!),
    /left join governed_ev_inputs as ev_input[\s\S]*and governed\."evInputStatus" = 'ready'/u,
  );
});

test("ClutchPacks canonical V3 repository projects the latest time-only semantic replay without changing its canonical origin", async () => {
  const row = {
    ...observationRow(),
    originSemanticObservationId: "72000000-0000-4000-8000-000000000004",
    semanticObservationId: "72000000-0000-4000-8000-000000000008",
    normalizedContentHash: "e".repeat(64),
    normalizedContent: {
      kind: "catalog",
      effectiveAt: "2026-08-27T19:18:00.000Z",
    },
    effectiveSourceTime: new Date("2026-08-27T19:18:00.000Z"),
    deliveryOccurrenceId: 43370n,
    collectedAt: new Date("2026-08-27T19:19:00.000Z"),
  };
  const fixture = fixtureClient({ row });
  const repository =
    new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
      fixture.database,
      ORGANIZATION_ID,
    );

  const snapshot = await repository.loadSnapshot({ readAt: READ_AT });

  assert.equal(snapshot.readAt, READ_AT);
  assert.equal(snapshot.throughSequence, "190");
  assert.deepEqual(snapshot.products[0]?.observation, {
    semanticObservationId: "72000000-0000-4000-8000-000000000008",
    originSemanticObservationId: "72000000-0000-4000-8000-000000000004",
    sourceRecordId: "72000000-0000-4000-8000-000000000005",
    providerRecordId: "72000000-0000-4000-8000-000000000001",
    normalizedContentHash: "e".repeat(64),
    hashVersion: "packscout.provider-observation-hash.v1",
    normalizedContent: {
      kind: "catalog",
      effectiveAt: "2026-08-27T19:18:00.000Z",
    },
    effectiveSourceTime: "2026-08-27T19:18:00.000Z",
    deliveryOccurrenceId: "43370",
    collectedAt: "2026-08-27T19:19:00.000Z",
    pins: {
      providerSourceRevisionId: "72000000-0000-4000-8000-000000000006",
      sourceInstanceId: "72000000-0000-4000-8000-000000000007",
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v3",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: "clutchpacks-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
      cursorCodecVersion: "dataforrest-cursor-v1",
      configurationHash: "d".repeat(64),
    },
  });
  assert.ok(hasCausalOccurrenceFence(fixture.queries[2]!));
});

test("ClutchPacks canonical V3 repository leaves latest semantic alignment to the canonical mapper", async () => {
  const fixture = fixtureClient({ row: observationRow() });
  await new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
    fixture.database,
    ORGANIZATION_ID,
  ).loadSnapshot({ readAt: READ_AT });
  const evidenceQuery = sqlText(fixture.queries[2]!);

  assert.doesNotMatch(evidenceQuery, /semantic\.normalized_content_json\s*=/u);
  assert.doesNotMatch(evidenceQuery, /semantic\.normalized_content_hash\s*=/u);
  assert.match(
    evidenceQuery,
    /semantic\.source_record_id = origin\.source_record_id/u,
  );
  assert.match(evidenceQuery, /semantic\.effective_source_time desc/u);
});

test("a late-inserted backdated duplicate cannot change the same governed read snapshot", async () => {
  const queries: Prisma.Sql[] = [];
  let lateDuplicateInserted = false;
  const original = observationRow();
  const lateDuplicate = {
    ...observationRow(),
    deliveryOccurrenceId: 43369n,
    providerSourceRevisionId: "72000000-0000-4000-8000-000000000008",
  };
  const database = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query);
      const queryIndex = (queries.length - 1) % 3;
      if (queryIndex === 0) {
        return [{ settledSequence: 200n, settledAt: new Date(READ_AT) }];
      }
      if (queryIndex === 1) return [{ throughSequence: 190n }];

      // Both deliveries claim the same pre-read collection time. The second
      // arrived on a page committed only after READ_AT. Model the SQL contract:
      // without the exact page/created-at fence it sorts first by its later id;
      // with the fence it is causally invisible.
      return lateDuplicateInserted && !hasCausalOccurrenceFence(query)
        ? [lateDuplicate]
        : [original];
    },
  } as unknown as PackscoutPrismaClient;
  const repository =
    new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
      database,
      ORGANIZATION_ID,
    );

  const before = await repository.loadSnapshot({ readAt: READ_AT });
  lateDuplicateInserted = true;
  const replay = await repository.loadSnapshot({ readAt: READ_AT });

  assert.equal(
    before.products[0]?.observation?.deliveryOccurrenceId,
    "43368",
  );
  assert.deepEqual(replay, before);
  assert.equal(queries.length, 6);
  assert.ok(hasCausalOccurrenceFence(queries[2]!));
  assert.ok(hasCausalOccurrenceFence(queries[5]!));
});

test("ClutchPacks canonical V3 repository retains every governed pack when evidence is absent", async () => {
  const row = observationRow();
  for (const key of [
    "originSemanticObservationId",
    "semanticObservationId",
    "sourceRecordId",
    "providerRecordId",
    "normalizedContentHash",
    "hashVersion",
    "normalizedContent",
    "effectiveSourceTime",
    "deliveryOccurrenceId",
    "collectedAt",
    "providerSourceRevisionId",
    "sourceInstanceId",
    "sourceTypeKey",
    "sourceAdapterVersion",
    "normalizedContractVersion",
    "mapperKey",
    "mapperVersion",
    "identityNamespaceKey",
    "cursorCodecVersion",
    "configurationHash",
  ]) {
    row[key] = null;
  }
  const fixture = fixtureClient({ row });
  const repository =
    new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
      fixture.database,
      ORGANIZATION_ID,
    );
  const snapshot = await repository.loadSnapshot({ readAt: READ_AT });
  assert.equal(snapshot.products.length, 1);
  assert.notEqual(snapshot.products[0]?.evInputRevision, null);
  assert.equal(snapshot.products[0]?.observation, null);
});

test("ClutchPacks canonical V3 repository fails closed when the pack has no matching governed EV input", async () => {
  const row = observationRow();
  for (const key of [
    "evInputRevisionId",
    "evInputCanonicalContentHash",
    "evInputCanonicalProvenanceHash",
    "evInputCanonicalPublicChangeSequence",
    "originSemanticObservationId",
    "semanticObservationId",
    "sourceRecordId",
    "providerRecordId",
    "normalizedContentHash",
    "hashVersion",
    "normalizedContent",
    "effectiveSourceTime",
    "deliveryOccurrenceId",
    "collectedAt",
    "providerSourceRevisionId",
    "sourceInstanceId",
    "sourceTypeKey",
    "sourceAdapterVersion",
    "normalizedContractVersion",
    "mapperKey",
    "mapperVersion",
    "identityNamespaceKey",
    "cursorCodecVersion",
    "configurationHash",
  ]) {
    row[key] = null;
  }
  const fixture = fixtureClient({ row });

  const snapshot = await new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
    fixture.database,
    ORGANIZATION_ID,
  ).loadSnapshot({ readAt: READ_AT });

  assert.equal(
    snapshot.products[0]?.productRevisionId,
    "72000000-0000-4000-8000-000000000002",
  );
  assert.equal(snapshot.products[0]?.evInputRevision, null);
  assert.equal(snapshot.products[0]?.observation, null);
  assert.match(
    sqlText(fixture.queries[2]!),
    /on ev_input\."productKey" = governed\."productKey"/u,
  );
});

test("ClutchPacks canonical V3 repository refuses invalid or unsettled read clocks", async () => {
  const invalid = fixtureClient({});
  await assert.rejects(
    new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
      invalid.database,
      ORGANIZATION_ID,
    ).loadSnapshot({ readAt: "2026-08-27" }),
    (error: unknown) =>
      error instanceof DataReleaseV3CanonicalSourceError &&
      error.code === "CANONICAL_READ_AT_INVALID",
  );
  assert.equal(invalid.queries.length, 0);

  const unsettled = fixtureClient({
    settledAt: new Date("2026-08-27T19:00:00.000Z"),
  });
  await assert.rejects(
    new PrismaClutchpacksCanonicalV3BuybackEvObservationRepository(
      unsettled.database,
      ORGANIZATION_ID,
    ).loadSnapshot({ readAt: READ_AT }),
    (error: unknown) =>
      error instanceof DataReleaseV3CanonicalSourceError &&
      error.code === "CANONICAL_STATE_UNSETTLED",
  );
  assert.equal(unsettled.queries.length, 1);
});
