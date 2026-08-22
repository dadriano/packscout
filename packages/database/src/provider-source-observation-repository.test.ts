import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  emptyNormalizedProviderFacts,
  launchRecordIdScopeDeclarations,
  normalizedObservationSemanticContent,
  normalizedProviderObservationSchema,
} from "@packscout/contracts";
import type { PackscoutTransactionClient } from "./database.ts";
import {
  hashNormalizedObservationSemanticContent,
  ProviderSourceObservationRepository,
  resolveLaunchSourceRecordMeaning,
  type RecordDeliveryOccurrenceInput,
  type UpsertSemanticObservationInput,
} from "./provider-source-observation-repository.ts";

const sourceRevisionId = "72000000-0000-4000-8000-000000000004";
const sourceRecordId = "72000000-0000-4000-8000-000000000005";
const semanticObservationId = "72000000-0000-4000-8000-000000000006";
const normalizedContent = normalizedObservationSemanticContent(
  normalizedProviderObservationSchema.parse({
    kind: "catalog",
    entity: "pack",
    providerRecordIdentity: {
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: "courtyard-pack-42",
    },
    effectiveAt: "2026-08-20T12:00:00.000Z",
    collectedAt: "2026-08-20T12:00:01.000Z",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    availability: "available",
    providerFacts: {
      ...emptyNormalizedProviderFacts("pack"),
      displayName: { state: "present", value: "Court Kings" },
    },
    relationships: [],
    protectedNativeEvidenceRef: "protected:page:record:0",
  }),
);

const observationInput = Object.freeze({
  organizationId: "72000000-0000-4000-8000-000000000001",
  providerId: "72000000-0000-4000-8000-000000000002",
  sourceInstanceId: "72000000-0000-4000-8000-000000000003",
  sourceRevisionId,
  recordIdScopeKey: "catalog-pack-v1",
  providerRecordId: "courtyard-pack-42",
  recordKind: "catalog",
  recordDiscriminator: "catalog_pack",
  effectiveSourceTime: new Date("2026-08-20T12:00:00.000Z"),
  normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
  hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
  normalizedContentHash:
    hashNormalizedObservationSemanticContent(normalizedContent),
  normalizedContent,
} satisfies UpsertSemanticObservationInput);

function unsafeObservationInput(
  value: unknown,
): UpsertSemanticObservationInput {
  return value as UpsertSemanticObservationInput;
}

test("every launch scope rejects every other source meaning before first insert", async () => {
  const repository = new ProviderSourceObservationRepository();
  let sourceLookups = 0;
  let identityWrites = 0;
  const transaction = {
    provider_source_instances: {
      findFirst: async () => {
        sourceLookups += 1;
        return { active_revision_id: sourceRevisionId };
      },
    },
    source_record_identities: {
      upsert: async () => {
        identityWrites += 1;
        return {
          id: sourceRecordId,
          record_kind: "catalog",
          record_discriminator: "catalog_pack",
        };
      },
    },
  } as unknown as PackscoutTransactionClient;
  const meanings = launchRecordIdScopeDeclarations.map(({ recordIdScopeKey }) =>
    resolveLaunchSourceRecordMeaning(recordIdScopeKey),
  );

  for (const { recordIdScopeKey } of launchRecordIdScopeDeclarations) {
    const expected = resolveLaunchSourceRecordMeaning(recordIdScopeKey);
    for (const meaning of meanings) {
      if (
        meaning.recordKind === expected.recordKind &&
        meaning.recordDiscriminator === expected.recordDiscriminator
      ) {
        continue;
      }
      await assert.rejects(
        repository.upsertSemanticObservationInTransaction(
          transaction,
          unsafeObservationInput({
            ...observationInput,
            recordIdScopeKey,
            ...meaning,
          }),
        ),
        /requires/u,
      );
    }
  }
  await assert.rejects(
    repository.upsertSemanticObservationInTransaction(
      transaction,
      unsafeObservationInput({
        ...observationInput,
        recordIdScopeKey: "future-scope-v1",
      }),
    ),
    /not part of the launch contract/u,
  );
  assert.equal(sourceLookups, 0);
  assert.equal(identityWrites, 0);
});

test("semantic identity rejects unsupported versions and an unverified caller hash", async () => {
  const repository = new ProviderSourceObservationRepository();
  let sourceLookups = 0;
  const transaction = {
    provider_source_instances: {
      findFirst: async () => {
        sourceLookups += 1;
        return { active_revision_id: sourceRevisionId };
      },
    },
  } as unknown as PackscoutTransactionClient;

  for (const [input, message] of [
    [
      { ...observationInput, normalizedContractVersion: "future-contract" },
      /contract version is unsupported/u,
    ],
    [
      { ...observationInput, hashVersion: "future-hash" },
      /hash version is unsupported/u,
    ],
    [
      { ...observationInput, normalizedContentHash: "a".repeat(64) },
      /does not match canonical semantic content/u,
    ],
  ] as const) {
    await assert.rejects(
      repository.upsertSemanticObservationInTransaction(
        transaction,
        unsafeObservationInput(input),
      ),
      message,
    );
  }
  assert.equal(sourceLookups, 0);
});

test("semantic content rejects delivery keys and mismatched identity, time, or meaning", async () => {
  const repository = new ProviderSourceObservationRepository();
  let sourceLookups = 0;
  const transaction = {
    provider_source_instances: {
      findFirst: async () => {
        sourceLookups += 1;
        return { active_revision_id: sourceRevisionId };
      },
    },
  } as unknown as PackscoutTransactionClient;
  const cases = [
    {
      input: {
        ...observationInput,
        normalizedContent: {
          ...normalizedContent,
          collectedAt: "2026-08-20T12:00:01.000Z",
        },
      },
      message: /unrecognized key|unrecognized_keys/iu,
    },
    {
      input: {
        ...observationInput,
        normalizedContent: {
          ...normalizedContent,
          providerRecordIdentity: {
            ...normalizedContent.providerRecordIdentity,
            providerRecordId: "other-pack",
          },
        },
      },
      message: /provider identity does not match/u,
    },
    {
      input: {
        ...observationInput,
        normalizedContent: {
          ...normalizedContent,
          effectiveAt: "2026-08-20T12:00:02.000Z",
        },
      },
      message: /effective time does not match/u,
    },
    {
      input: {
        ...observationInput,
        normalizedContent: {
          ...normalizedContent,
          entity: "card",
          providerFacts: emptyNormalizedProviderFacts("card"),
        },
      },
      message: /scope_mismatch|kind or catalog entity does not match/u,
    },
  ];
  for (const scenario of cases) {
    await assert.rejects(
      repository.upsertSemanticObservationInTransaction(
        transaction,
        unsafeObservationInput({
          ...scenario.input,
          normalizedContentHash: observationInput.normalizedContentHash,
        }),
      ),
      scenario.message,
    );
  }
  assert.equal(sourceLookups, 0);
});

test("semantic upsert reports novelty without assigning a delivery or canonical outcome", async () => {
  const repository = new ProviderSourceObservationRepository();
  let semanticInsertCount = 0;
  let occurrenceWrites = 0;
  const transaction = {
    provider_source_instances: {
      findFirst: async () => ({ active_revision_id: sourceRevisionId }),
    },
    source_record_identities: {
      upsert: async () => ({
        id: sourceRecordId,
        record_kind: "catalog",
        record_discriminator: "catalog_pack",
      }),
    },
    source_semantic_observations: {
      createMany: async () => ({ count: semanticInsertCount++ === 0 ? 1 : 0 }),
      findUniqueOrThrow: async () => ({ id: semanticObservationId }),
    },
    source_delivery_occurrences: {
      create: async () => {
        occurrenceWrites += 1;
        return { id: 1n };
      },
    },
  } as unknown as PackscoutTransactionClient;

  const first = await repository.upsertSemanticObservationInTransaction(
    transaction,
    observationInput,
  );
  const replay = await repository.upsertSemanticObservationInTransaction(
    transaction,
    observationInput,
  );

  assert.deepEqual(first, {
    kind: "ready",
    sourceRecordId,
    semanticObservationId,
    semanticObservationCreated: true,
  });
  assert.deepEqual(replay, {
    kind: "ready",
    sourceRecordId,
    semanticObservationId,
    semanticObservationCreated: false,
  });
  assert.equal("disposition" in first, false);
  assert.equal(occurrenceWrites, 0);
});

test("a frozen source identity conflict remains a candidate for the page transaction", async () => {
  const repository = new ProviderSourceObservationRepository();
  let observationWrites = 0;
  const transaction = {
    provider_source_instances: {
      findFirst: async () => ({ active_revision_id: sourceRevisionId }),
    },
    source_record_identities: {
      upsert: async () => ({
        id: sourceRecordId,
        record_kind: "trade",
        record_discriminator: "trade",
      }),
    },
    source_semantic_observations: {
      createMany: async () => {
        observationWrites += 1;
        return { count: 1 };
      },
    },
  } as unknown as PackscoutTransactionClient;

  assert.deepEqual(
    await repository.upsertSemanticObservationInTransaction(
      transaction,
      observationInput,
    ),
    {
      kind: "identity_conflict",
      sourceRecordId,
      semanticObservationId: null,
      reasonCode: "source_identity_conflict",
    },
  );
  assert.equal(observationWrites, 0);
});

const occurrenceBase = Object.freeze({
  organizationId: observationInput.organizationId,
  providerId: observationInput.providerId,
  sourceInstanceId: observationInput.sourceInstanceId,
  sourceRevisionId,
  runId: "72000000-0000-4000-8000-000000000007",
  pageId: "72000000-0000-4000-8000-000000000008",
  requestAttemptId: "72000000-0000-4000-8000-000000000009",
  sourceTypeKey: "dataforrest-events-v1",
  sourceAdapterVersion: "dataforrest-events-adapter-v1",
  normalizedContractVersion: observationInput.normalizedContractVersion,
  mapperKey: "courtyard-provider-observation",
  mapperVersion: "1",
  identityNamespaceKey: "dataforrest-courtyard-records-v1",
  checkpointCodecVersion: "dataforrest-cursor-v1",
  checkpointGeneration: 1n,
  connectionHealthGeneration: 0n,
  supervisorEpochId: "72000000-0000-4000-8000-000000000010",
  connectionProfileId: "72000000-0000-4000-8000-000000000011",
  connectionRevisionId: "72000000-0000-4000-8000-000000000012",
  collectedAt: new Date("2026-08-20T12:00:01.000Z"),
  nativeEvidenceReference: "raw-page:one:record:zero",
});

test("the atomic page boundary records all four exclusive dispositions", async () => {
  const repository = new ProviderSourceObservationRepository();
  const writes: Array<Record<string, unknown>> = [];
  const transaction = {
    source_delivery_occurrences: {
      create: async (query: { data: Record<string, unknown> }) => {
        writes.push(query.data);
        return { id: BigInt(writes.length) };
      },
    },
  } as unknown as PackscoutTransactionClient;
  const decisions = [
    { disposition: "inserted", sourceRecordId, semanticObservationId },
    { disposition: "revised", sourceRecordId, semanticObservationId },
    { disposition: "duplicate", sourceRecordId, semanticObservationId },
    {
      disposition: "quarantined",
      sourceRecordId: null,
      semanticObservationId: null,
      reasonCode: "normalized_record_invalid",
    },
    {
      disposition: "quarantined",
      sourceRecordId,
      semanticObservationId: null,
      reasonCode: "source_identity_conflict",
    },
    {
      disposition: "quarantined",
      sourceRecordId,
      semanticObservationId,
      reasonCode: "immutable_content_conflict",
    },
  ] as const;

  for (const [recordIndex, decision] of decisions.entries()) {
    await repository.recordDeliveryOccurrenceInTransaction(transaction, {
      ...occurrenceBase,
      ...decision,
      recordIndex,
    } satisfies RecordDeliveryOccurrenceInput);
  }

  assert.deepEqual(
    writes.map(({ disposition, reason_code: reasonCode }) => ({
      disposition,
      reasonCode,
    })),
    [
      { disposition: "inserted", reasonCode: null },
      { disposition: "revised", reasonCode: null },
      { disposition: "duplicate", reasonCode: null },
      { disposition: "quarantined", reasonCode: "normalized_record_invalid" },
      { disposition: "quarantined", reasonCode: "source_identity_conflict" },
      { disposition: "quarantined", reasonCode: "immutable_content_conflict" },
    ],
  );
});

test("a verified page fence lets later upserts skip the source lookup only on request", async () => {
  const repository = new ProviderSourceObservationRepository();
  let sourceLookups = 0;
  let semanticInsertCount = 0;
  const transaction = {
    provider_source_instances: {
      findFirst: async () => {
        sourceLookups += 1;
        return { active_revision_id: sourceRevisionId };
      },
    },
    source_record_identities: {
      upsert: async () => ({
        id: sourceRecordId,
        record_kind: "catalog",
        record_discriminator: "catalog_pack",
      }),
    },
    source_semantic_observations: {
      createMany: async () => ({ count: semanticInsertCount++ === 0 ? 1 : 0 }),
      findUniqueOrThrow: async () => ({ id: semanticObservationId }),
    },
  } as unknown as PackscoutTransactionClient;

  await repository.upsertSemanticObservationInTransaction(
    transaction,
    observationInput,
  );
  assert.equal(sourceLookups, 1);
  await repository.upsertSemanticObservationInTransaction(
    transaction,
    observationInput,
    { skipSourceRevisionFenceCheck: true },
  );
  assert.equal(sourceLookups, 1);
  await repository.upsertSemanticObservationInTransaction(
    transaction,
    observationInput,
    { skipSourceRevisionFenceCheck: false },
  );
  assert.equal(sourceLookups, 2);
});

test("the batched delivery boundary writes every disposition in one insert", async () => {
  const repository = new ProviderSourceObservationRepository();
  const batches: Array<Array<Record<string, unknown>>> = [];
  const transaction = {
    source_delivery_occurrences: {
      createMany: async (query: { data: Array<Record<string, unknown>> }) => {
        batches.push(query.data);
        return { count: query.data.length };
      },
    },
  } as unknown as PackscoutTransactionClient;

  await repository.recordDeliveryOccurrencesInTransaction(transaction, []);
  assert.equal(batches.length, 0);

  await repository.recordDeliveryOccurrencesInTransaction(transaction, [
    {
      ...occurrenceBase,
      recordIndex: 0,
      disposition: "inserted",
      sourceRecordId,
      semanticObservationId,
    },
    {
      ...occurrenceBase,
      recordIndex: 1,
      disposition: "duplicate",
      sourceRecordId,
      semanticObservationId,
    },
  ]);
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]?.map((row) => ({
      recordIndex: row.record_index,
      disposition: row.disposition,
      reasonCode: row.reason_code,
      sourceRecordId: row.source_record_id,
      semanticObservationId: row.semantic_observation_id,
    })),
    [
      {
        recordIndex: 0,
        disposition: "inserted",
        reasonCode: null,
        sourceRecordId,
        semanticObservationId,
      },
      {
        recordIndex: 1,
        disposition: "duplicate",
        reasonCode: null,
        sourceRecordId,
        semanticObservationId,
      },
    ],
  );

  await assert.rejects(
    repository.recordDeliveryOccurrencesInTransaction(transaction, [
      {
        ...occurrenceBase,
        recordIndex: 0,
        disposition: "inserted",
        sourceRecordId,
        semanticObservationId,
      },
      {
        ...occurrenceBase,
        recordIndex: -1,
        disposition: "inserted",
        sourceRecordId,
        semanticObservationId,
      },
    ]),
    /nonnegative safe integer/,
  );
  assert.equal(batches.length, 1);
});

test("delivery validation rejects lineage and reason combinations the database forbids", async () => {
  const repository = new ProviderSourceObservationRepository();
  const transaction = {
    source_delivery_occurrences: {
      create: async () => ({ id: 1n }),
    },
  } as unknown as PackscoutTransactionClient;

  await assert.rejects(
    repository.recordDeliveryOccurrenceInTransaction(transaction, {
      ...occurrenceBase,
      recordIndex: 0,
      disposition: "quarantined",
      sourceRecordId: null,
      semanticObservationId,
      reasonCode: "immutable_content_conflict",
    }),
    /cannot exist without its source record/,
  );
  await assert.rejects(
    repository.recordDeliveryOccurrenceInTransaction(transaction, {
      ...occurrenceBase,
      recordIndex: 0,
      disposition: "quarantined",
      sourceRecordId: null,
      semanticObservationId: null,
      reasonCode: "unsafe reason",
    }),
    /bounded safe reference/,
  );
});
