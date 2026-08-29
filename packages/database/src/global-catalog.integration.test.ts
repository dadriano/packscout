import assert from "node:assert/strict";
import { test } from "node:test";
import type { MigratedCentralTestDatabase } from "./test-support.ts";
import {
  CATALOG_FIXTURE_IDS,
  GLOBAL_CATALOG_CANONICAL_FIXTURES,
  catalogFixtureIdentity,
} from "./global-catalog-canonical-fixtures.ts";
import {
  GlobalCatalogCorrelationRepository,
  evidenceForTarget,
} from "./global-catalog-repository.ts";
import { GlobalCatalogMaintenanceRepository } from "./global-catalog-maintenance-repository.ts";
import { GlobalCategoryCorrelationRepository } from "./global-category-correlation-repository.ts";
import { createMigratedCentralTestDatabase } from "./test-support.ts";

const CATEGORY_IDS = Object.freeze({
  root: "70000000-0000-4000-8000-000000000001",
  cards: "70000000-0000-4000-8000-000000000002",
  other: "70000000-0000-4000-8000-000000000003",
  providerLocal: "60000000-0000-4000-8000-000000000001",
  concurrentLocal: "60000000-0000-4000-8000-000000000002",
});

const EXTRA_LOCAL_IDS = Object.freeze({
  crossProvider: "20000000-0000-4000-8000-000000000010",
  wrongType: "20000000-0000-4000-8000-000000000011",
  retiredProvisional: "20000000-0000-4000-8000-000000000012",
});

const BASE_TIME = Date.parse("2026-08-29T20:00:00.000Z");

function at(minutes: number): Date {
  return new Date(BASE_TIME + minutes * 60_000);
}

async function seedAuthorities(harness: MigratedCentralTestDatabase): Promise<void> {
  await harness.client.organizations.createMany({
    data: [
      {
        id: CATALOG_FIXTURE_IDS.organization,
        slug: "catalog-fixture-one",
        name: "Catalog fixture one",
      },
      {
        id: CATALOG_FIXTURE_IDS.secondOrganization,
        slug: "catalog-fixture-two",
        name: "Catalog fixture two",
      },
    ],
  });
  await harness.client.providers.createMany({
    data: [
      {
        id: CATALOG_FIXTURE_IDS.provider,
        organization_id: CATALOG_FIXTURE_IDS.organization,
        provider_key: "catalog_fixture_one",
        display_name: "Catalog fixture one",
      },
      {
        id: CATALOG_FIXTURE_IDS.secondProvider,
        organization_id: CATALOG_FIXTURE_IDS.secondOrganization,
        provider_key: "catalog_fixture_two",
        display_name: "Catalog fixture two",
      },
    ],
  });
}

function actor(reason: string, occurredAt: Date) {
  return {
    actorType: "test_fixture" as const,
    actorId: `fixture:${reason}`,
    reason,
    occurredAt,
  };
}

async function seedCatalog(maintenance: GlobalCatalogMaintenanceRepository): Promise<void> {
  await maintenance.upsertGlobalCategory({
    categoryId: CATEGORY_IDS.root,
    parentCategoryId: null,
    categoryKey: "collectibles",
    displayName: "Collectibles",
    categoryKind: "vertical",
    displayOrder: 0,
    ...actor("root-category", at(-10)),
  });
  await maintenance.upsertGlobalCategory({
    categoryId: CATEGORY_IDS.cards,
    parentCategoryId: CATEGORY_IDS.root,
    categoryKey: "cards",
    displayName: "Cards",
    categoryKind: "other",
    displayOrder: 1,
    ...actor("cards-category", at(-9)),
  });
  await maintenance.upsertGlobalCategory({
    categoryId: CATEGORY_IDS.other,
    parentCategoryId: CATEGORY_IDS.root,
    categoryKey: "other-collectibles",
    displayName: "Other Collectibles",
    categoryKind: "other",
    displayOrder: 2,
    ...actor("other-category", at(-8)),
  });
  const inputs = [
    [CATALOG_FIXTURE_IDS.firstCanonicalCollectible, "Canonical One"],
    [CATALOG_FIXTURE_IDS.secondCanonicalCollectible, "Canonical Two"],
    [CATALOG_FIXTURE_IDS.mergeAliasCollectible, "Merge Alias"],
  ] as const;
  for (const [collectibleId, name] of inputs) {
    await maintenance.upsertCanonicalCollectible({
      collectibleId,
      primaryCategoryId: CATEGORY_IDS.cards,
      collectibleType: "card",
      publicIdentity: catalogFixtureIdentity(name),
      ...actor(`collectible-${name}`, at(-7)),
    });
  }
}

test(
  "shared global catalog is deterministic, temporal, aliased, and atomically invalidated",
  { concurrency: false },
  async (context) => {
    let harness: MigratedCentralTestDatabase;
    try {
      harness = await createMigratedCentralTestDatabase();
    } catch (error) {
      if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
        context.skip("PostgreSQL 16 test infrastructure is not available.");
        return;
      }
      throw error;
    }
    try {
      await seedAuthorities(harness);
      const maintenance = new GlobalCatalogMaintenanceRepository(harness.client);
      const correlation = new GlobalCatalogCorrelationRepository(harness.client);
      const categories = new GlobalCategoryCorrelationRepository(harness.client);
      await seedCatalog(maintenance);

      const fixtures = GLOBAL_CATALOG_CANONICAL_FIXTURES;
      const unique = await correlation.correlateCollectible(
        fixtures.deterministicUniqueMatch.request,
      );
      assert.equal(unique.outcome, fixtures.deterministicUniqueMatch.expectedOutcome);
      assert.equal(
        unique.currentGlobalCollectibleId,
        fixtures.deterministicUniqueMatch.expectedGlobalCollectibleId,
      );

      const provisional = await correlation.correlateCollectible(
        fixtures.unmatchedProvisional.request,
      );
      assert.equal(provisional.outcome, fixtures.unmatchedProvisional.expectedOutcome);
      assert.equal(
        provisional.currentGlobalCollectibleId,
        fixtures.unmatchedProvisional.expectedGlobalCollectibleId,
      );

      const ambiguous = await correlation.correlateCollectible(
        fixtures.ambiguousSuggestion.request,
      );
      assert.equal(ambiguous.outcome, fixtures.ambiguousSuggestion.expectedOutcome);
      assert.equal(
        ambiguous.currentGlobalCollectibleId,
        fixtures.ambiguousSuggestion.expectedGlobalCollectibleId,
      );
      const ambiguousActive = await harness.client.provider_collectible_correlations
        .findFirstOrThrow({
          where: {
            provider_id: CATALOG_FIXTURE_IDS.provider,
            local_collectible_id: CATALOG_FIXTURE_IDS.ambiguousLocalCollectible,
            valid_to_event_sequence: null,
          },
        });
      assert.equal(ambiguousActive.global_collectible_id, ambiguous.currentGlobalCollectibleId);
      assert.equal(ambiguousActive.method, "provisional");
      assert.equal(await harness.client.correlation_suggestions.count({
        where: {
          provider_id: CATALOG_FIXTURE_IDS.provider,
          local_collectible_id: CATALOG_FIXTURE_IDS.ambiguousLocalCollectible,
          review_state: "pending",
        },
      }), 2);

      const changedProvisionalBase = {
        ...fixtures.ambiguousSuggestion.request,
        localEntityVersion: 2n,
        publicIdentity: catalogFixtureIdentity("Updated Provisional Identity"),
        deterministicEvidence: [],
        providerChangeSequence: 9n,
        observedAt: at(29),
      };
      const changedProvisional = await correlation.correlateCollectible({
        ...changedProvisionalBase,
        deterministicEvidence: [
          evidenceForTarget({
            request: changedProvisionalBase,
            globalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
          }),
          evidenceForTarget({
            request: changedProvisionalBase,
            globalCollectibleId: CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
          }),
        ],
      });
      assert.equal(changedProvisional.outcome, "suggested");
      assert.equal(changedProvisional.currentGlobalCollectibleId, ambiguous.currentGlobalCollectibleId);
      const refreshedProvisional = await harness.client.global_collectibles.findUniqueOrThrow({
        where: { id: ambiguous.currentGlobalCollectibleId },
      });
      assert.equal(refreshedProvisional.display_name, "Updated Provisional Identity");
      assert.equal(refreshedProvisional.row_version, 2n);
      assert.equal(await harness.client.catalog_promotion_changes.count({
        where: {
          entity_type: "global_collectible",
          entity_id: ambiguous.currentGlobalCollectibleId,
          entity_version: 2n,
          operation: "upsert",
        },
      }), 1);

      const replayCountsBefore = await Promise.all([
        harness.client.catalog_decision_events.count(),
        harness.client.catalog_promotion_changes.count(),
        harness.client.provider_collectible_correlations.count(),
      ]);
      const replay = await correlation.correlateCollectible({
        ...fixtures.exactReplay.request,
        observedAt: at(30),
      });
      assert.equal(replay.outcome, fixtures.exactReplay.expectedOutcome);
      assert.equal(replay.currentGlobalCollectibleId, provisional.currentGlobalCollectibleId);
      assert.equal(replay.catalogEventSequence, provisional.catalogEventSequence);
      assert.deepEqual(await Promise.all([
        harness.client.catalog_decision_events.count(),
        harness.client.catalog_promotion_changes.count(),
        harness.client.provider_collectible_correlations.count(),
      ]), replayCountsBefore);

      const merge = await maintenance.mergeCollectibles({
        aliasCollectibleId: fixtures.mergeAlias.aliasCollectibleId,
        canonicalCollectibleId: fixtures.mergeAlias.canonicalCollectibleId,
        expectedAliasRowVersion: 1n,
        ...actor("merge-alias", at(31)),
      });
      assert.equal(merge.materialChange, true);
      assert.equal(
        await maintenance.resolveCollectibleId(fixtures.mergeAlias.aliasCollectibleId),
        fixtures.mergeAlias.expectedResolvedCollectibleId,
      );
      assert.equal(
        await maintenance.resolveCollectibleId(fixtures.mergeAlias.canonicalCollectibleId),
        fixtures.mergeAlias.expectedResolvedCollectibleId,
      );
      const aliasCycleLedger = await harness.client.catalog_ledger.findUniqueOrThrow({
        where: { singleton_key: true },
      });
      await assert.rejects(
        maintenance.mergeCollectibles({
          aliasCollectibleId: fixtures.mergeAlias.canonicalCollectibleId,
          canonicalCollectibleId: fixtures.mergeAlias.aliasCollectibleId,
          ...actor("cycle", at(32)),
        }),
        (error: unknown) => (
          error instanceof Error && "code" in error && error.code === "ALIAS_CYCLE"
        ),
      );
      assert.equal((await harness.client.catalog_ledger.findUniqueOrThrow({
        where: { singleton_key: true },
      })).last_sequence, aliasCycleLedger.last_sequence);

      const promoteRequest = {
        ...fixtures.unmatchedProvisional.request,
        localEntityVersion: 2n,
        providerChangeSequence: 4n,
        observedAt: at(40),
      };
      const promoted = await correlation.correlateCollectible({
        ...promoteRequest,
        deterministicEvidence: [evidenceForTarget({
          request: promoteRequest,
          globalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
        })],
      });
      assert.equal(promoted.outcome, "linked");
      assert.equal(
        await maintenance.resolveCollectibleId(provisional.currentGlobalCollectibleId),
        CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
      );
      const temporalRows = await harness.client.provider_collectible_correlations.findMany({
        where: {
          provider_id: CATALOG_FIXTURE_IDS.provider,
          local_collectible_id: CATALOG_FIXTURE_IDS.unmatchedLocalCollectible,
        },
        orderBy: { correlation_version: "asc" },
      });
      assert.equal(temporalRows.length, 2);
      assert.notEqual(temporalRows[0]!.valid_to_event_sequence, null);
      assert.equal(temporalRows[1]!.valid_to_event_sequence, null);

      const stale = await correlation.correlateCollectible({
        ...promoteRequest,
        localEntityVersion: 1n,
        providerChangeSequence: 5n,
        observedAt: at(41),
      });
      assert.equal(stale.outcome, "rejected");
      assert.equal(stale.failureCode, "STALE_LOCAL_VERSION");

      const conflictRequest = {
        ...fixtures.deterministicUniqueMatch.request,
        localEntityVersion: 2n,
        providerChangeSequence: 6n,
        observedAt: at(42),
      };
      const deterministicConflict = await correlation.correlateCollectible({
        ...conflictRequest,
        deterministicEvidence: [evidenceForTarget({
          request: conflictRequest,
          globalCollectibleId: CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
        })],
      });
      assert.equal(deterministicConflict.outcome, "rejected");
      assert.equal(deterministicConflict.failureCode, "DETERMINISTIC_OUTCOME_CONFLICT");

      const crossProviderRequest = {
        ...fixtures.unmatchedProvisional.request,
        localCollectibleId: EXTRA_LOCAL_IDS.crossProvider,
        providerChangeSequence: 7n,
        observedAt: at(43),
      };
      const crossProvider = await correlation.correlateCollectible({
        ...crossProviderRequest,
        deterministicEvidence: [{
          ...evidenceForTarget({
            request: crossProviderRequest,
            globalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
          }),
          providerId: CATALOG_FIXTURE_IDS.secondProvider,
        }],
      });
      assert.equal(crossProvider.outcome, "rejected");
      assert.equal(crossProvider.failureCode, "CROSS_PROVIDER_EVIDENCE");

      const wrongTypeRequest = {
        ...fixtures.unmatchedProvisional.request,
        localCollectibleId: EXTRA_LOCAL_IDS.wrongType,
        collectibleType: "watch" as const,
        providerChangeSequence: 8n,
        observedAt: at(44),
      };
      const wrongType = await correlation.correlateCollectible({
        ...wrongTypeRequest,
        deterministicEvidence: [evidenceForTarget({
          request: wrongTypeRequest,
          globalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
        })],
      });
      assert.equal(wrongType.outcome, "rejected");
      assert.equal(wrongType.failureCode, "GLOBAL_TYPE_INCOMPATIBLE");

      const replayConflict = await correlation.correlateCollectible({
        ...fixtures.deterministicUniqueMatch.request,
        ruleVersion: "conflicting-replay",
        observedAt: at(45),
      });
      assert.equal(replayConflict.outcome, "rejected");
      assert.equal(replayConflict.failureCode, "SOURCE_REPLAY_CONFLICT");
      assert.notEqual(replayConflict.catalogEventSequence, unique.catalogEventSequence);
      const replayConflictAgain = await correlation.correlateCollectible({
        ...fixtures.deterministicUniqueMatch.request,
        ruleVersion: "another-conflicting-replay",
        observedAt: at(46),
      });
      assert.equal(replayConflictAgain.catalogEventSequence, replayConflict.catalogEventSequence);

      const secondProviderRequest = {
        ...fixtures.unmatchedProvisional.request,
        providerId: CATALOG_FIXTURE_IDS.secondProvider,
        providerChangeSequence: 1n,
        observedAt: at(47),
      };
      const secondProvider = await correlation.correlateCollectible(secondProviderRequest);
      assert.equal(secondProvider.outcome, "provisional_created");
      assert.notEqual(secondProvider.currentGlobalCollectibleId, provisional.currentGlobalCollectibleId);
      const sameVersionIdentityConflict = await correlation.correlateCollectible({
        ...secondProviderRequest,
        publicIdentity: catalogFixtureIdentity("Conflicting Same Version Identity"),
        providerChangeSequence: 2n,
        observedAt: at(48),
      });
      assert.equal(sameVersionIdentityConflict.outcome, "rejected");
      assert.equal(
        sameVersionIdentityConflict.failureCode,
        "DETERMINISTIC_OUTCOME_CONFLICT",
      );

      const retiredProvisionalRequest = {
        ...fixtures.unmatchedProvisional.request,
        localCollectibleId: EXTRA_LOCAL_IDS.retiredProvisional,
        providerChangeSequence: 10n,
        observedAt: at(48),
      };
      const retiredProvisional = await correlation.correlateCollectible(
        retiredProvisionalRequest,
      );
      assert.equal(retiredProvisional.outcome, "provisional_created");
      await maintenance.mergeCollectibles({
        aliasCollectibleId: retiredProvisional.currentGlobalCollectibleId,
        canonicalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
        expectedAliasRowVersion: 1n,
        ...actor("retire-active-provisional", at(49)),
      });
      const missingProvisional = await correlation.correlateCollectible({
        ...retiredProvisionalRequest,
        localEntityVersion: 2n,
        providerChangeSequence: 11n,
        observedAt: at(50),
      });
      assert.equal(missingProvisional.outcome, "rejected");
      assert.equal(missingProvisional.failureCode, "MISSING_PROVISIONAL");

      await maintenance.mergeCollectibles({
        aliasCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
        canonicalCollectibleId: CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
        expectedAliasRowVersion: 1n,
        ...actor("merge-active-deterministic-target", at(51)),
      });
      const aliasEvidenceRequest = {
        ...fixtures.deterministicUniqueMatch.request,
        localEntityVersion: 2n,
        deterministicEvidence: [],
        providerChangeSequence: 12n,
        observedAt: at(52),
      };
      const aliasReconciled = await correlation.correlateCollectible({
        ...aliasEvidenceRequest,
        deterministicEvidence: [evidenceForTarget({
          request: aliasEvidenceRequest,
          globalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
        })],
      });
      assert.equal(aliasReconciled.outcome, "linked");
      assert.equal(
        aliasReconciled.currentGlobalCollectibleId,
        CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
      );
      assert.equal(
        await maintenance.resolveCollectibleId(CATALOG_FIXTURE_IDS.firstCanonicalCollectible),
        CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
      );
      const uniqueHistory = await harness.client.provider_collectible_correlations.findMany({
        where: {
          provider_id: CATALOG_FIXTURE_IDS.provider,
          local_collectible_id: CATALOG_FIXTURE_IDS.uniqueLocalCollectible,
        },
        orderBy: { correlation_version: "asc" },
      });
      assert.equal(uniqueHistory.length, 2);
      assert.notEqual(uniqueHistory[0]!.valid_to_event_sequence, null);
      assert.equal(uniqueHistory[1]!.global_collectible_id, CATALOG_FIXTURE_IDS.secondCanonicalCollectible);

      const resolveAmbiguousRequest = {
        ...changedProvisionalBase,
        localEntityVersion: 3n,
        deterministicEvidence: [],
        providerChangeSequence: 13n,
        observedAt: at(53),
      };
      const resolvedAmbiguous = await correlation.correlateCollectible({
        ...resolveAmbiguousRequest,
        deterministicEvidence: [evidenceForTarget({
          request: resolveAmbiguousRequest,
          globalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
        })],
      });
      assert.equal(resolvedAmbiguous.outcome, "linked");
      assert.equal(
        resolvedAmbiguous.currentGlobalCollectibleId,
        CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
      );
      assert.equal(await harness.client.correlation_suggestions.count({
        where: {
          provider_id: CATALOG_FIXTURE_IDS.provider,
          local_collectible_id: CATALOG_FIXTURE_IDS.ambiguousLocalCollectible,
          review_state: "pending",
        },
      }), 0);
      assert.equal(
        await maintenance.resolveCollectibleId(ambiguous.currentGlobalCollectibleId),
        CATALOG_FIXTURE_IDS.secondCanonicalCollectible,
      );

      const categoryV1 = await categories.correlateCategory({
        providerId: CATALOG_FIXTURE_IDS.provider,
        localCategoryId: CATEGORY_IDS.providerLocal,
        localEntityVersion: 1n,
        globalCategoryId: CATEGORY_IDS.cards,
        ruleVersion: "category-v1",
        confidenceBasisPoints: 10_000,
        providerChangeSequence: 20n,
        observedAt: at(50),
      });
      assert.equal(categoryV1.outcome, "linked");
      const categoryReplay = await categories.correlateCategory({
        providerId: CATALOG_FIXTURE_IDS.provider,
        localCategoryId: CATEGORY_IDS.providerLocal,
        localEntityVersion: 1n,
        globalCategoryId: CATEGORY_IDS.cards,
        ruleVersion: "category-v1",
        confidenceBasisPoints: 10_000,
        providerChangeSequence: 20n,
        observedAt: at(80),
      });
      assert.equal(categoryReplay.outcome, "unchanged");
      assert.equal(categoryReplay.catalogEventSequence, categoryV1.catalogEventSequence);
      const categoryV2 = await categories.correlateCategory({
        providerId: CATALOG_FIXTURE_IDS.provider,
        localCategoryId: CATEGORY_IDS.providerLocal,
        localEntityVersion: 2n,
        globalCategoryId: CATEGORY_IDS.cards,
        ruleVersion: "category-v1",
        confidenceBasisPoints: 10_000,
        providerChangeSequence: 21n,
        observedAt: at(51),
      });
      assert.equal(categoryV2.outcome, "linked");
      assert.equal(await harness.client.provider_category_correlations.count({
        where: {
          provider_id: CATALOG_FIXTURE_IDS.provider,
          local_category_id: CATEGORY_IDS.providerLocal,
        },
      }), 2);
      const categoryStale = await categories.correlateCategory({
        providerId: CATALOG_FIXTURE_IDS.provider,
        localCategoryId: CATEGORY_IDS.providerLocal,
        localEntityVersion: 1n,
        globalCategoryId: CATEGORY_IDS.cards,
        ruleVersion: "category-v1",
        confidenceBasisPoints: 10_000,
        providerChangeSequence: 22n,
        observedAt: at(52),
      });
      assert.equal(categoryStale.outcome, "rejected");
      assert.equal(categoryStale.failureCode, "STALE_LOCAL_VERSION");
      const categoryConflict = await categories.correlateCategory({
        providerId: CATALOG_FIXTURE_IDS.provider,
        localCategoryId: CATEGORY_IDS.providerLocal,
        localEntityVersion: 3n,
        globalCategoryId: CATEGORY_IDS.other,
        ruleVersion: "category-v1",
        confidenceBasisPoints: 10_000,
        providerChangeSequence: 24n,
        observedAt: at(52),
      });
      assert.equal(categoryConflict.outcome, "rejected");
      assert.equal(categoryConflict.failureCode, "DETERMINISTIC_OUTCOME_CONFLICT");

      const independent = await harness.createIndependentLifecycle();
      try {
        const concurrentInput = {
          providerId: CATALOG_FIXTURE_IDS.provider,
          localCategoryId: CATEGORY_IDS.concurrentLocal,
          localEntityVersion: 1n,
          globalCategoryId: CATEGORY_IDS.cards,
          ruleVersion: "category-v1",
          confidenceBasisPoints: 9_900,
          providerChangeSequence: 25n,
          observedAt: at(53),
        } as const;
        const concurrent = await Promise.all([
          categories.correlateCategory(concurrentInput),
          new GlobalCategoryCorrelationRepository(independent.client)
            .correlateCategory(concurrentInput),
        ]);
        assert.equal(concurrent[0].catalogEventSequence, concurrent[1].catalogEventSequence);
        assert.equal(await harness.client.provider_category_correlations.count({
          where: {
            provider_id: CATALOG_FIXTURE_IDS.provider,
            local_category_id: CATEGORY_IDS.concurrentLocal,
            valid_to_event_sequence: null,
          },
        }), 1);
      } finally {
        await independent.close();
      }

      await categories.correlateCategory({
        providerId: CATALOG_FIXTURE_IDS.secondProvider,
        localCategoryId: CATEGORY_IDS.providerLocal,
        localEntityVersion: 1n,
        globalCategoryId: CATEGORY_IDS.cards,
        ruleVersion: "category-v1",
        confidenceBasisPoints: 10_000,
        providerChangeSequence: 2n,
        observedAt: at(54),
      });
      const invalidationsBeforeCategoryUpdate = await harness.client
        .provider_release_invalidations.count();
      await maintenance.upsertGlobalCategory({
        categoryId: CATEGORY_IDS.cards,
        parentCategoryId: CATEGORY_IDS.root,
        categoryKey: "cards",
        displayName: "Trading Cards",
        categoryKind: "other",
        displayOrder: 1,
        expectedRowVersion: 1n,
        ...actor("category-display-update", at(55)),
      });
      const categoryUpdateInvalidations = await harness.client
        .provider_release_invalidations.findMany({
          skip: invalidationsBeforeCategoryUpdate,
          orderBy: { sequence: "asc" },
          select: { provider_id: true },
        });
      assert.deepEqual(
        categoryUpdateInvalidations.map((item) => item.provider_id),
        [CATALOG_FIXTURE_IDS.provider, CATALOG_FIXTURE_IDS.secondProvider].sort(),
      );

      const ledgerBeforeCycle = await harness.client.catalog_ledger.findUniqueOrThrow({
        where: { singleton_key: true },
      });
      const promotionsBeforeCycle = await harness.client.catalog_promotion_changes.count();
      await assert.rejects(maintenance.upsertGlobalCategory({
        categoryId: CATEGORY_IDS.root,
        parentCategoryId: CATEGORY_IDS.cards,
        categoryKey: "collectibles",
        displayName: "Collectibles",
        categoryKind: "vertical",
        displayOrder: 0,
        expectedRowVersion: 1n,
        ...actor("category-cycle", at(56)),
      }));
      assert.equal((await harness.client.catalog_ledger.findUniqueOrThrow({
        where: { singleton_key: true },
      })).last_sequence, ledgerBeforeCycle.last_sequence);
      assert.equal(
        await harness.client.catalog_promotion_changes.count(),
        promotionsBeforeCycle,
      );
      assert.equal((await harness.client.global_categories.findUniqueOrThrow({
        where: { id: CATEGORY_IDS.root },
      })).parent_category_id, null);

      const [catalogLedger, decisionCount, promotionCount] = await Promise.all([
        harness.client.catalog_ledger.findUniqueOrThrow({ where: { singleton_key: true } }),
        harness.client.catalog_decision_events.count(),
        harness.client.catalog_promotion_changes.count(),
      ]);
      assert.equal(catalogLedger.last_sequence, BigInt(decisionCount + promotionCount));
      const [invalidationLedger, invalidationCount] = await Promise.all([
        harness.client.provider_release_invalidation_ledger.findUniqueOrThrow({
          where: { singleton_key: true },
        }),
        harness.client.provider_release_invalidations.count(),
      ]);
      assert.equal(invalidationLedger.last_sequence, BigInt(invalidationCount));
      const missingCorrelationInvalidations = await harness.client.$queryRaw<
        readonly { missing_count: bigint }[]
      >`
        SELECT count(*)::bigint AS missing_count
        FROM "catalog_promotion_changes" change
        WHERE change.entity_type IN (
          'provider_category_correlation',
          'provider_collectible_correlation'
        )
          AND NOT EXISTS (
            SELECT 1
            FROM "provider_release_invalidations" invalidation
            WHERE invalidation.provider_id = change.provider_id
              AND invalidation.catalog_change_sequence = change.sequence
          )
      `;
      assert.equal(missingCorrelationInvalidations[0]?.missing_count, 0n);
    } finally {
      await harness.close();
    }
  },
);
