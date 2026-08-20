import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  canonicalCatalogPlatformKeys,
  createPublicDerivationObligations,
} from "./public-change-settlement-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "53000000-0000-4000-8000-000000000001";
const crossOrganizationId = "53000000-0000-4000-8000-000000000002";
const constraintOrganizationId = "53000000-0000-4000-8000-000000000003";

async function seedProviders(
  database: Awaited<ReturnType<typeof createMigratedTestDatabase>>["client"],
  scopedOrganizationId: string,
  platformKeys: readonly string[],
): Promise<void> {
  await database.organizations.create({
    data: {
      id: scopedOrganizationId,
      slug: `provider-catalog-${scopedOrganizationId.at(-1)}`,
      name: "Provider Catalog Settlement",
    },
  });
  await database.provider_sources.createMany({
    data: platformKeys.map((platformKey) => ({
      organization_id: scopedOrganizationId,
      platform_key: platformKey,
      display_name: platformKey.toUpperCase(),
      state: "active" as const,
    })),
  });
}

async function loadCheckpoints(
  database: Awaited<ReturnType<typeof createMigratedTestDatabase>>["client"],
  scopedOrganizationId: string,
) {
  return database.provider_catalog_checkpoints.findMany({
    where: { organization_id: scopedOrganizationId },
    orderBy: { platform_key: "asc" },
  });
}

test("a failed provider and an earlier affected obligation do not stop an unrelated provider", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedProviders(harness.client, organizationId, ["alpha", "beta"]);
    const startedAt = new Date("2026-08-16T01:00:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:alpha-1",
          sourceKey: "alpha",
          occurredAt: startedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: startedAt,
      });
    });

    const betaFailureAt = new Date("2026-08-16T01:01:00.000Z");
    let betaSequence = 0n;
    await harness.client.$transaction(async (transaction) => {
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:beta-failure",
          sourceKey: "beta",
          occurredAt: betaFailureAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["beta"],
          },
        }],
      });
      betaSequence = cause!.sequence;
      await createPublicDerivationObligations(transaction, {
        organizationId,
        causeSequences: [betaSequence],
        derivationKind: "estimated_ev",
        derivationKey: "beta-failure",
        createdAt: betaFailureAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: betaFailureAt,
      });
    });
    await harness.client.public_derivation_obligations.updateMany({
      where: { organization_id: organizationId, cause_sequence: betaSequence },
      data: {
        state: "technical_failure",
        outcome_classification: "technical_failure",
        outcome_reason_code: "PROVIDER_TECHNICAL_FAILURE",
        acknowledged_claim_token: randomUUID(),
        outcome_at: betaFailureAt,
        updated_at: betaFailureAt,
      },
    });

    const laterAt = new Date("2026-08-16T01:02:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:alpha-2",
          sourceKey: "alpha",
          occurredAt: laterAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: laterAt,
      });
    });
    let checkpoints = await loadCheckpoints(harness.client, organizationId);
    assert.deepEqual(
      checkpoints.map(({ platform_key, settled_sequence, source_head_sequence }) =>
        [platform_key, settled_sequence, source_head_sequence]),
      [["alpha", 3n, 3n], ["beta", 0n, 2n]],
    );

    const pendingAt = new Date("2026-08-16T01:03:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      const causes = await allocatePublicChangeCauses(transaction, {
        organizationId,
        changes: ["blocked", "later"].map((suffix) => ({
          changeKind: "manual_correction" as const,
          entityKey: `canonical:v1:alpha-${suffix}`,
          sourceKey: "alpha",
          occurredAt: pendingAt,
          catalogImpact: {
            kind: "catalog" as const,
            providerPlatformKeys: ["alpha"],
          },
        })),
      });
      await createPublicDerivationObligations(transaction, {
        organizationId,
        causeSequences: [causes[0]!.sequence],
        derivationKind: "estimated_ev",
        derivationKey: "alpha-earlier-obligation",
        createdAt: pendingAt,
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId,
        settledAt: pendingAt,
      });
    });
    checkpoints = await loadCheckpoints(harness.client, organizationId);
    assert.deepEqual(
      checkpoints.map(({ platform_key, settled_sequence, source_head_sequence }) =>
        [platform_key, settled_sequence, source_head_sequence]),
      [["alpha", 3n, 5n], ["beta", 0n, 2n]],
    );
    const global = await harness.client.settled_public_watermarks.findUniqueOrThrow({
      where: { organization_id: organizationId },
    });
    assert.equal(global.settled_sequence, 1n);
  } finally {
    await harness.close();
  }
});

test("cross-provider impact, replay, stale acknowledgement, and concurrent advancement stay exact", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedProviders(
      harness.client,
      crossOrganizationId,
      ["alpha", "beta", "gamma"],
    );
    const causedAt = new Date("2026-08-16T02:00:00.000Z");
    let crossSequence = 0n;
    await harness.client.$transaction(async (transaction) => {
      const [cross] = await allocatePublicChangeCauses(transaction, {
        organizationId: crossOrganizationId,
        changes: [{
          changeKind: "relationship_resolution",
          entityKey: "relationship:v1:cross-provider",
          occurredAt: causedAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["alpha", "beta"],
          },
        }],
      });
      crossSequence = cross!.sequence;
      for (let replay = 0; replay < 2; replay += 1) {
        await createPublicDerivationObligations(transaction, {
          organizationId: crossOrganizationId,
          causeSequences: [crossSequence, crossSequence],
          derivationKind: "estimated_ev",
          derivationKey: "cross-provider-obligation",
          createdAt: causedAt,
        });
      }
      await advanceSettledPublicWatermark(transaction, {
        organizationId: crossOrganizationId,
        settledAt: causedAt,
      });
    });
    assert.equal(await harness.client.public_derivation_obligations.count(), 1);
    assert.equal(await harness.client.public_change_catalog_impacts.count(), 1);

    const gammaAt = new Date("2026-08-16T02:01:00.000Z");
    await harness.client.$transaction(async (transaction) => {
      await allocatePublicChangeCauses(transaction, {
        organizationId: crossOrganizationId,
        changes: [{
          changeKind: "provider_projection",
          entityKey: "canonical:v1:gamma",
          sourceKey: "gamma",
          occurredAt: gammaAt,
          catalogImpact: {
            kind: "catalog",
            providerPlatformKeys: ["gamma"],
          },
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: crossOrganizationId,
        settledAt: gammaAt,
      });
    });
    let checkpoints = await loadCheckpoints(harness.client, crossOrganizationId);
    assert.deepEqual(
      checkpoints.map(({ platform_key, settled_sequence }) =>
        [platform_key, settled_sequence]),
      [["alpha", 0n], ["beta", 0n], ["gamma", 2n]],
    );

    const staleToken = randomUUID();
    const activeToken = randomUUID();
    const claimExpiresAt = new Date("2026-08-16T02:01:30.000Z");
    await harness.client.public_derivation_obligations.updateMany({
      where: { organization_id: crossOrganizationId, cause_sequence: crossSequence },
      data: {
        state: "claimed",
        claimed_by: "worker-current",
        claim_token: activeToken,
        claim_expires_at: claimExpiresAt,
        updated_at: causedAt,
      },
    });
    const staleAcknowledgement = await harness.client.$executeRaw(Prisma.sql`
      update public.public_derivation_obligations
      set state = 'succeeded', acknowledged_claim_token = ${staleToken}::uuid,
          outcome_classification = 'success', outcome_at = ${gammaAt},
          claimed_by = null, claim_token = null, claim_expires_at = null
      where organization_id = ${crossOrganizationId}::uuid
        and cause_sequence = ${crossSequence}
        and state = 'claimed'
        and claim_token = ${staleToken}::uuid
    `);
    assert.equal(staleAcknowledgement, 0);

    await harness.client.public_derivation_obligations.updateMany({
      where: {
        organization_id: crossOrganizationId,
        cause_sequence: crossSequence,
        state: "claimed",
        claim_token: activeToken,
      },
      data: {
        state: "succeeded",
        claimed_by: null,
        claim_token: null,
        claim_expires_at: null,
        outcome_classification: "success",
        acknowledged_claim_token: activeToken,
        outcome_at: gammaAt,
        updated_at: gammaAt,
      },
    });
    const independent = await harness.createIndependentClient();
    await Promise.all([
      harness.client.$transaction((transaction) =>
        advanceSettledPublicWatermark(transaction, {
          organizationId: crossOrganizationId,
          settledAt: gammaAt,
        })),
      independent.$transaction((transaction) =>
        advanceSettledPublicWatermark(transaction, {
          organizationId: crossOrganizationId,
          settledAt: new Date("2026-08-16T01:59:00.000Z"),
        })),
    ]);
    checkpoints = await loadCheckpoints(harness.client, crossOrganizationId);
    assert.deepEqual(
      checkpoints.map(({ platform_key, settled_sequence }) =>
        [platform_key, settled_sequence]),
      [["alpha", 1n], ["beta", 1n], ["gamma", 2n]],
    );
    await assert.rejects(
      harness.client.public_change_catalog_impacts.update({
        where: {
          organization_id_cause_sequence: {
            organization_id: crossOrganizationId,
            cause_sequence: crossSequence,
          },
        },
        data: { provider_platform_keys: ["alpha"] },
      }),
      /immutable/i,
    );
  } finally {
    await harness.close();
  }
});

async function insertRawCause(
  transaction: PackscoutTransactionClient,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    insert into public.settled_public_watermarks (
      organization_id, next_sequence, source_head_sequence, source_head_at
    ) values (
      ${constraintOrganizationId}::uuid, 2, 1,
      '2026-08-16T05:00:00.000Z'::timestamptz
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    insert into public.public_change_causes (
      organization_id, sequence, change_kind, entity_key, occurred_at,
      authoritative_transaction_id
    ) values (
      ${constraintOrganizationId}::uuid, 1, 'manual_correction',
      'canonical:v1:constraint-test',
      '2026-08-16T05:00:00.000Z'::timestamptz, 'constraint-test'
    )
  `);
}

test("PostgreSQL rejects partial epoch/lifecycle tuples and inconsistent lifecycle impact sets", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedProviders(harness.client, constraintOrganizationId, ["alpha"]);
    assert.deepEqual(
      canonicalCatalogPlatformKeys(["beta", "alpha", "beta"]),
      ["alpha", "beta"],
    );
    for (const providerPlatformKeys of [
      ["beta", "alpha"],
      ["alpha", "alpha"],
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    ]) {
      await assert.rejects(
        harness.client.$transaction((transaction) =>
          allocatePublicChangeCauses(transaction, {
            organizationId: constraintOrganizationId,
            changes: [{
              changeKind: "manual_correction",
              entityKey: "canonical:v1:invalid-provider-set",
              occurredAt: new Date("2026-08-16T05:00:00.000Z"),
              catalogImpact: { kind: "catalog", providerPlatformKeys },
            }],
          })),
        /strictly sorted and unique|launch platform bound/i,
      );
    }
    await assert.rejects(
      allocatePublicChangeCauses(
        harness.client as unknown as PackscoutTransactionClient,
        {
          organizationId: constraintOrganizationId,
          changes: [{
            changeKind: "manual_correction",
            entityKey: "canonical:v1:root-client",
            occurredAt: new Date("2026-08-16T05:00:00.000Z"),
            catalogImpact: { kind: "none" },
          }],
        },
      ),
      /active database transaction/i,
    );
    const invalidImpacts = [
      (transaction: PackscoutTransactionClient) => transaction.$executeRaw(
        Prisma.sql`
          insert into public.public_change_catalog_impacts (
            organization_id, cause_sequence, shared_configuration_key,
            shared_configuration_hash
          ) values (
            ${constraintOrganizationId}::uuid, 1, 'catalog-r1', ${"a".repeat(64)}
          )
        `,
      ),
      (transaction: PackscoutTransactionClient) => transaction.$executeRaw(
        Prisma.sql`
          insert into public.public_change_catalog_impacts (
            organization_id, cause_sequence, lifecycle_platform_key
          ) values (${constraintOrganizationId}::uuid, 1, 'alpha')
        `,
      ),
      (transaction: PackscoutTransactionClient) => transaction.$executeRaw(
        Prisma.sql`
          insert into public.public_change_catalog_impacts (
            organization_id, cause_sequence, lifecycle_platform_key,
            lifecycle_state
          ) values (
            ${constraintOrganizationId}::uuid, 1, 'alpha', 'active'
          )
        `,
      ),
      (transaction: PackscoutTransactionClient) => transaction.$executeRaw(
        Prisma.sql`
          insert into public.public_change_catalog_impacts (
            organization_id, cause_sequence, provider_platform_keys,
            lifecycle_platform_key, lifecycle_state
          ) values (
            ${constraintOrganizationId}::uuid, 1, array['alpha']::text[],
            'alpha', 'disabled'
          )
        `,
      ),
    ];
    for (const insertImpact of invalidImpacts) {
      await assert.rejects(
        harness.client.$transaction(async (transaction) => {
          await insertRawCause(transaction);
          await insertImpact(transaction);
        }),
        /check constraint/i,
      );
    }
    assert.equal(await harness.client.public_change_causes.count(), 0);
    assert.equal(await harness.client.public_change_catalog_impacts.count(), 0);
  } finally {
    await harness.close();
  }
});
