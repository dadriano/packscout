import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  PROVIDER_OBSERVATION_HASH_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION_V2,
  emptyNormalizedProviderFacts,
  launchRecordIdScopeDeclarations,
  normalizedObservationSemanticContentSchema,
  normalizedObservationSemanticContentV2Schema,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import {
  hashNormalizedObservationSemanticContent,
  hashNormalizedObservationSemanticContentV2,
  ProviderSourceObservationRepository,
  resolveLaunchSourceRecordMeaning,
  type UpsertSemanticObservationInput,
} from "./provider-source-observation-repository.ts";
import {
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";

const sourceDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
  intervalSeconds: 60,
  hashCharacter: "b",
} as const;

test("canonical text keeps a trailing v and rejects actual trim whitespace", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "observation-text-canonicalization",
  );
  try {
    const [result] = await fixture.database.$queryRaw<Array<{
      trailing_v: boolean;
      leading_vertical_tab: boolean;
      trailing_vertical_tab: boolean;
    }>>`
      select
        normalized_text_is_canonical('provider-record-v', 4096)
          as trailing_v,
        normalized_text_is_canonical(chr(11) || 'provider-record-v', 4096)
          as leading_vertical_tab,
        normalized_text_is_canonical('provider-record-v' || chr(11), 4096)
          as trailing_vertical_tab
    `;

    assert.deepEqual(result, {
      trailing_v: true,
      leading_vertical_tab: false,
      trailing_vertical_tab: false,
    });
  } finally {
    await fixture.close();
  }
});

test("observation v2 persists one-target pulls in a separate strict history domain", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "observation-v2-packless-pulls",
  );
  try {
    const providerId = await fixture.setup.createProviderSource({
      organizationId: fixture.organizationId,
      platformKey: "clutchpacks",
      displayName: "ClutchPacks",
      createdAt: ACCEPTANCE_CREATED_AT,
    });
    const source = await fixture.lifecycle.createSourceInstanceRevision({
      organizationId: fixture.organizationId,
      providerId,
      connectionProfileId: fixture.connectionProfileId,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
      mapperKey: "clutchpacks-provider-observation",
      mapperVersion: "2",
      identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
      cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
      revisionNumber: 1,
      intervalSeconds: 60,
      configuration: { provider: "clutchpacks" },
      configurationHash: "7".repeat(64),
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
      actorKey: "operator-admin",
      createdAt: ACCEPTANCE_CREATED_AT,
    });
    assert.equal(
      (
        await fixture.database.provider_source_revisions.findUniqueOrThrow({
          where: { id: source.sourceRevisionId },
        })
      ).normalized_contract_version,
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    );

    const repository = new ProviderSourceObservationRepository();
    const relationshipVariants = [
      [{
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "v2-card-42",
        },
      }],
      [{
        relationship: "pack",
        target: {
          recordIdScopeKey: "catalog-pack-v1",
          providerRecordId: "v2-pack-42",
        },
      }],
      [
        {
          relationship: "card",
          target: {
            recordIdScopeKey: "catalog-card-v1",
            providerRecordId: "v2-card-42",
          },
        },
        {
          relationship: "pack",
          target: {
            recordIdScopeKey: "catalog-pack-v1",
            providerRecordId: "v2-pack-42",
          },
        },
      ],
    ] as const;
    const persisted = [] as Array<{
      sourceRecordId: string;
      semanticObservationId: string;
    }>;
    for (const [index, relationships] of relationshipVariants.entries()) {
      const providerRecordId = `v2-pull-${index + 1}`;
      const content = normalizedObservationSemanticContentV2Schema.parse({
        kind: "pull",
        providerRecordIdentity: {
          recordIdScopeKey: "pull-v1",
          providerRecordId,
        },
        effectiveAt: ACCEPTANCE_CREATED_AT.toISOString(),
        providerFacts: emptyNormalizedProviderFacts("pull"),
        relationships,
      });
      const result = await fixture.database.$transaction((transaction) =>
        repository.upsertSemanticObservationInTransaction(transaction, {
          organizationId: fixture.organizationId,
          providerId,
          sourceInstanceId: source.sourceInstanceId,
          sourceRevisionId: source.sourceRevisionId,
          recordIdScopeKey: "pull-v1",
          providerRecordId,
          recordKind: "pull",
          recordDiscriminator: "pull",
          effectiveSourceTime: ACCEPTANCE_CREATED_AT,
          normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
          hashVersion: PROVIDER_OBSERVATION_HASH_VERSION_V2,
          normalizedContentHash:
            hashNormalizedObservationSemanticContentV2(content),
          normalizedContent: content,
        }),
      );
      assert.equal(result.kind, "ready");
      if (result.kind === "ready") persisted.push(result);
    }
    assert.equal(persisted.length, 3);
    const stored = await fixture.database.source_semantic_observations.findMany({
      where: { id: { in: persisted.map(({ semanticObservationId }) =>
        semanticObservationId) } },
      orderBy: { normalized_content_hash: "asc" },
    });
    assert.equal(stored.length, 3);
    assert.deepEqual(
      new Set(stored.map(({ normalized_contract_version: version }) => version)),
      new Set([PROVIDER_OBSERVATION_CONTRACT_VERSION_V2]),
    );
    assert.deepEqual(
      new Set(stored.map(({ hash_version: version }) => version)),
      new Set([PROVIDER_OBSERVATION_HASH_VERSION_V2]),
    );

    const oneTargetRow = (relationship: "card" | "pack") => stored.find((row) =>
      (row.normalized_content_json as { relationships?: unknown[] })
        .relationships?.length === 1 &&
      (row.normalized_content_json as {
        relationships?: Array<{ relationship?: string }>;
      }).relationships?.[0]?.relationship === relationship
    )!;
    const cardOnly = oneTargetRow("card");
    const cardOnlyContent = normalizedObservationSemanticContentV2Schema.parse(
      cardOnly.normalized_content_json,
    );
    for (const [index, oneTarget] of [cardOnly, oneTargetRow("pack")].entries()) {
      await assert.rejects(
        fixture.database.source_semantic_observations.create({
          data: {
            organization_id: fixture.organizationId,
            source_record_id: oneTarget.source_record_id,
            effective_source_time: ACCEPTANCE_CREATED_AT,
            normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
            hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
            normalized_content_hash: String(index + 8).repeat(64),
            normalized_content_json:
              normalizedObservationSemanticContentV2Schema.parse(
                oneTarget.normalized_content_json,
              ),
          },
        }),
        /semantic (?:pull content|relationship set)/u,
      );
    }
    await assert.rejects(
      fixture.database.source_semantic_observations.create({
        data: {
          organization_id: fixture.organizationId,
          source_record_id: cardOnly.source_record_id,
          effective_source_time: ACCEPTANCE_CREATED_AT,
          normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
          hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
          normalized_content_hash: "9".repeat(64),
          normalized_content_json: cardOnlyContent,
        },
      }),
      /source_semantic_observations_content_check/u,
    );
    for (const [normalizedContentHash, relationships, message] of [
      ["a".repeat(64), [], /semantic pull content/u],
      [
        "b".repeat(64),
        [
          {
            relationship: "pack",
            target: {
              recordIdScopeKey: "catalog-pack-v1",
              providerRecordId: "duplicate-pack-1",
            },
          },
          {
            relationship: "pack",
            target: {
              recordIdScopeKey: "catalog-pack-v1",
              providerRecordId: "duplicate-pack-2",
            },
          },
        ],
        /semantic relationship set is duplicated/u,
      ],
    ] as const) {
      await assert.rejects(
        fixture.database.source_semantic_observations.create({
          data: {
            organization_id: fixture.organizationId,
            source_record_id: cardOnly.source_record_id,
            effective_source_time: ACCEPTANCE_CREATED_AT,
            normalized_contract_version:
              PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
            hash_version: PROVIDER_OBSERVATION_HASH_VERSION_V2,
            normalized_content_hash: normalizedContentHash,
            normalized_content_json: {
              ...cardOnlyContent,
              relationships: [...relationships],
            },
          },
        }),
        message,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("launch scope meaning and canonical semantic identity fail closed in PostgreSQL", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "observation-invariants",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      sourceDefinition,
    );
    const meanings = launchRecordIdScopeDeclarations.map(
      ({ recordIdScopeKey }) =>
        resolveLaunchSourceRecordMeaning(recordIdScopeKey),
    );
    let mismatchIndex = 0;
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
          fixture.database.source_record_identities.create({
            data: {
              organization_id: fixture.organizationId,
              provider_id: source.providerId,
              source_instance_id: source.sourceInstanceId,
              record_id_scope_key: recordIdScopeKey,
              provider_record_id: `mismatch-${mismatchIndex++}`,
              record_kind: meaning.recordKind,
              record_discriminator: meaning.recordDiscriminator,
            },
          }),
          /source_record_identities_scope_meaning_check/u,
        );
      }
    }
    await assert.rejects(
      fixture.database.source_record_identities.create({
        data: {
          organization_id: fixture.organizationId,
          provider_id: source.providerId,
          source_instance_id: source.sourceInstanceId,
          record_id_scope_key: "future-scope-v1",
          provider_record_id: "future-scope-record",
          record_kind: "catalog",
          record_discriminator: "catalog_pack",
        },
      }),
      /source_record_identities_scope_meaning_check/u,
    );
    assert.equal(await fixture.database.source_record_identities.count(), 0);

    const effectiveAt = ACCEPTANCE_CREATED_AT.toISOString();
    const semanticContent = normalizedObservationSemanticContentSchema.parse({
      kind: "catalog",
      entity: "pack",
      providerRecordIdentity: {
        recordIdScopeKey: "catalog-pack-v1",
        providerRecordId: "canonical-pack-42",
      },
      effectiveAt,
      firstSeenAt: effectiveAt,
      availability: "available",
      providerFacts: {
        ...emptyNormalizedProviderFacts("pack"),
        displayName: { state: "present", value: "Court Kings" },
      },
      relationships: [],
    });
    const reorderedSemanticContent = {
      relationships: [],
      availability: "available",
      providerFacts: {
        ...emptyNormalizedProviderFacts("pack"),
        displayName: { state: "present", value: "Court Kings" },
      },
      firstSeenAt: "2026-08-20T05:00:00.000-07:00",
      effectiveAt: "2026-08-20T05:00:00.000-07:00",
      providerRecordIdentity: {
        providerRecordId: "canonical-pack-42",
        recordIdScopeKey: "catalog-pack-v1",
      },
      entity: "pack",
      kind: "catalog",
    };
    const reorderedParsed = normalizedObservationSemanticContentSchema.parse(
      reorderedSemanticContent,
    );
    const changedSemanticContent =
      normalizedObservationSemanticContentSchema.parse({
        ...semanticContent,
        availability: "unavailable",
      });
    const semanticHash =
      hashNormalizedObservationSemanticContent(semanticContent);
    assert.equal(
      hashNormalizedObservationSemanticContent(reorderedSemanticContent),
      semanticHash,
    );
    assert.notEqual(
      hashNormalizedObservationSemanticContent(changedSemanticContent),
      semanticHash,
    );

    const repository = new ProviderSourceObservationRepository();
    const baseInput = {
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: "canonical-pack-42",
      recordKind: "catalog",
      recordDiscriminator: "catalog_pack",
      effectiveSourceTime: ACCEPTANCE_CREATED_AT,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
      normalizedContentHash: semanticHash,
      normalizedContent: semanticContent,
    } as const satisfies UpsertSemanticObservationInput;
    const upsert = (input: UpsertSemanticObservationInput) =>
      fixture.database.$transaction((transaction) =>
        repository.upsertSemanticObservationInTransaction(transaction, input),
      );

    const first = await upsert(baseInput);
    assert.equal(first.kind, "ready");
    assert.equal(first.semanticObservationCreated, true);
    const replay = await upsert({
      ...baseInput,
      normalizedContentHash: hashNormalizedObservationSemanticContent(
        reorderedSemanticContent,
      ),
      normalizedContent: reorderedParsed,
    });
    assert.equal(replay.kind, "ready");
    assert.equal(replay.semanticObservationCreated, false);
    assert.equal(replay.semanticObservationId, first.semanticObservationId);

    const changed = await upsert({
      ...baseInput,
      normalizedContentHash: hashNormalizedObservationSemanticContent(
        changedSemanticContent,
      ),
      normalizedContent: changedSemanticContent,
    });
    assert.equal(changed.kind, "ready");
    assert.equal(changed.semanticObservationCreated, true);
    assert.notEqual(changed.semanticObservationId, first.semanticObservationId);
    assert.equal(
      await fixture.database.source_semantic_observations.count(),
      2,
    );

    const pullFromOffsetInput = {
      kind: "pull",
      providerRecordIdentity: {
        recordIdScopeKey: "pull-v1",
        providerRecordId: "canonical-pull-42",
      },
      effectiveAt: "2026-08-20T05:00:00.000-07:00",
      providerFacts: emptyNormalizedProviderFacts("pull"),
      relationships: [
        {
          relationship: "card",
          target: {
            recordIdScopeKey: "catalog-card-v1",
            providerRecordId: "canonical-card-42",
          },
        },
        {
          relationship: "pack",
          target: {
            recordIdScopeKey: "catalog-pack-v1",
            providerRecordId: "canonical-pack-42",
          },
        },
      ],
    } as const;
    const pullFromOffset = normalizedObservationSemanticContentSchema.parse(
      pullFromOffsetInput,
    );
    const canonicalPullInput = {
      ...pullFromOffsetInput,
      effectiveAt,
      relationships: [...pullFromOffsetInput.relationships].reverse(),
    };
    const canonicalPull =
      normalizedObservationSemanticContentSchema.parse(canonicalPullInput);
    assert.deepEqual(pullFromOffset, canonicalPull);
    const pullHash =
      hashNormalizedObservationSemanticContent(pullFromOffsetInput);
    assert.equal(
      hashNormalizedObservationSemanticContent(canonicalPullInput),
      pullHash,
    );
    const pullInput = {
      ...baseInput,
      recordIdScopeKey: "pull-v1",
      providerRecordId: "canonical-pull-42",
      recordKind: "pull",
      recordDiscriminator: "pull",
      normalizedContentHash: pullHash,
      normalizedContent: pullFromOffset,
    } as const satisfies UpsertSemanticObservationInput;
    const firstPull = await upsert(pullInput);
    assert.equal(firstPull.kind, "ready");
    assert.equal(firstPull.semanticObservationCreated, true);
    const replayedPull = await upsert({
      ...pullInput,
      normalizedContentHash:
        hashNormalizedObservationSemanticContent(canonicalPull),
      normalizedContent: canonicalPull,
    });
    assert.equal(replayedPull.kind, "ready");
    assert.equal(replayedPull.semanticObservationCreated, false);
    assert.equal(
      replayedPull.semanticObservationId,
      firstPull.semanticObservationId,
    );
    const storedPull =
      await fixture.database.source_semantic_observations.findUniqueOrThrow({
        where: { id: firstPull.semanticObservationId },
      });
    assert.deepEqual(storedPull.normalized_content_json, canonicalPull);
    assert.equal(
      await fixture.database.source_semantic_observations.count(),
      3,
    );

    const forgedHash = semanticHash === "0".repeat(64)
      ? "1".repeat(64)
      : "0".repeat(64);
    await assert.rejects(
      fixture.database.source_semantic_observations.create({
        data: {
          organization_id: fixture.organizationId,
          source_record_id: first.sourceRecordId,
          effective_source_time: ACCEPTANCE_CREATED_AT,
          normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
          hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
          normalized_content_hash: forgedHash,
          normalized_content_json: semanticContent,
        },
      }),
      /semantic observation hash and canonical content disagree/u,
    );
    await assert.rejects(
      fixture.database.source_semantic_observations.create({
        data: {
          organization_id: fixture.organizationId,
          source_record_id: first.sourceRecordId,
          effective_source_time: ACCEPTANCE_CREATED_AT,
          normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
          hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
          normalized_content_hash: semanticHash,
          normalized_content_json: changedSemanticContent,
        },
      }),
      /semantic observation hash and canonical content disagree/u,
    );

    for (const noncanonicalTimestampContent of [
      {
        ...semanticContent,
        effectiveAt: "2026-08-20T05:00:00.000-07:00",
      },
      {
        ...semanticContent,
        firstSeenAt: "2026-08-20T05:00:00.000-07:00",
      },
    ]) {
      await assert.rejects(
        fixture.database.source_semantic_observations.create({
          data: {
            organization_id: fixture.organizationId,
            source_record_id: first.sourceRecordId,
            effective_source_time: ACCEPTANCE_CREATED_AT,
            normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
            hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
            normalized_content_hash: forgedHash,
            normalized_content_json: noncanonicalTimestampContent,
          },
        }),
        /semantic (?:observation|catalog) content/u,
      );
    }

    await assert.rejects(
      fixture.database.source_semantic_observations.create({
        data: {
          organization_id: fixture.organizationId,
          source_record_id: firstPull.sourceRecordId,
          effective_source_time: ACCEPTANCE_CREATED_AT,
          normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
          hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
          normalized_content_hash: "2".repeat(64),
          normalized_content_json: {
            ...canonicalPull,
            relationships: [...canonicalPull.relationships].reverse(),
          },
        },
      }),
      /semantic relationship set is incomplete or noncanonical/u,
    );

    for (const noncanonicalPackFacts of [
      {
        ...semanticContent.providerFacts,
        price: {
          state: "present",
          value: { amount: 10, currency: "usd" },
        },
      },
      {
        ...semanticContent.providerFacts,
        displayName: { state: "present", value: " Court Kings" },
      },
      {
        ...semanticContent.providerFacts,
        displayName: null,
      },
    ]) {
      await assert.rejects(
        fixture.database.source_semantic_observations.create({
          data: {
            organization_id: fixture.organizationId,
            source_record_id: first.sourceRecordId,
            effective_source_time: ACCEPTANCE_CREATED_AT,
            normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
            hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
            normalized_content_hash: "3".repeat(64),
            normalized_content_json: {
              ...semanticContent,
              providerFacts: noncanonicalPackFacts,
            },
          },
        }),
        /semantic pack provider facts are invalid/u,
      );
    }

    const tradeSourceRecord =
      await fixture.database.source_record_identities.create({
        data: {
          organization_id: fixture.organizationId,
          provider_id: source.providerId,
          source_instance_id: source.sourceInstanceId,
          record_id_scope_key: "trade-v1",
          provider_record_id: "canonical-trade-42",
          record_kind: "trade",
          record_discriminator: "trade",
        },
      });
    await assert.rejects(
      fixture.database.source_semantic_observations.create({
        data: {
          organization_id: fixture.organizationId,
          source_record_id: tradeSourceRecord.id,
          effective_source_time: ACCEPTANCE_CREATED_AT,
          normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
          hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
          normalized_content_hash: "4".repeat(64),
          normalized_content_json: {
            kind: "trade",
            providerRecordIdentity: {
              recordIdScopeKey: "trade-v1",
              providerRecordId: "canonical-trade-42",
            },
            effectiveAt,
            providerFacts: emptyNormalizedProviderFacts("trade"),
            relationships: [
              {
                relationship: "card",
                target: {
                  recordIdScopeKey: "catalog-card-v1",
                  providerRecordId: "canonical-card-42",
                },
              },
            ],
            eventType: "sale",
            amount: 10,
            currency: "usd",
            paymentMethod: null,
          },
        },
      }),
      /semantic trade content does not match its frozen meaning/u,
    );

    for (const invalidSemanticContent of [
      { ...semanticContent, collectedAt: effectiveAt },
      {
        ...semanticContent,
        providerRecordIdentity: {
          ...semanticContent.providerRecordIdentity,
          providerRecordId: "other-pack",
        },
      },
      {
        ...semanticContent,
        effectiveAt: new Date(
          ACCEPTANCE_CREATED_AT.getTime() + 1_000,
        ).toISOString(),
      },
      {
        ...semanticContent,
        providerFacts: {
          ...semanticContent.providerFacts,
          rawData: { vendorField: true },
        },
      },
    ]) {
      await assert.rejects(
        fixture.database.source_semantic_observations.create({
          data: {
            organization_id: fixture.organizationId,
            source_record_id: first.sourceRecordId,
            effective_source_time: ACCEPTANCE_CREATED_AT,
            normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
            hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
            normalized_content_hash: "f".repeat(64),
            normalized_content_json: invalidSemanticContent,
          },
        }),
        /semantic (?:observation|catalog|pack provider facts)/u,
      );
    }

    for (const versionOverride of [
      { normalized_contract_version: "future-contract" },
      { hash_version: "future-hash" },
    ]) {
      await assert.rejects(
        fixture.database.source_semantic_observations.create({
          data: {
            organization_id: fixture.organizationId,
            source_record_id: first.sourceRecordId,
            effective_source_time: ACCEPTANCE_CREATED_AT,
            normalized_contract_version: PROVIDER_OBSERVATION_CONTRACT_VERSION,
            hash_version: PROVIDER_OBSERVATION_HASH_VERSION,
            normalized_content_hash: semanticHash,
            normalized_content_json: semanticContent,
            ...versionOverride,
          },
        }),
        /source_semantic_observations_content_check/u,
      );
    }
  } finally {
    await fixture.close();
  }
});
