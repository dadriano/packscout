import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { sanitizeAuthAuditMetadata } from "./security.ts";

export const FIRST_ADMIN_BOOTSTRAP_ACTOR_KEY =
  "system:local-first-admin-bootstrap";

export type FirstAdminBootstrapResult =
  | Readonly<{
      kind: "created";
      organizationId: string;
      operatorId: string;
    }>
  | Readonly<{ kind: "operator_already_present" }>
  | Readonly<{ kind: "development_seed_not_exact" }>;

type CountableDelegate = Readonly<{ count(): Promise<number> }>;

function countableDelegate(
  transaction: Prisma.TransactionClient,
  modelName: string,
): CountableDelegate {
  const delegate = (transaction as unknown as Record<string, unknown>)[modelName];
  if (
    !delegate ||
    typeof delegate !== "object" ||
    typeof (delegate as { count?: unknown }).count !== "function"
  ) {
    throw new Error("Prisma model is unavailable during first-admin bootstrap.");
  }
  return delegate as CountableDelegate;
}

/**
 * Atomic data edge for creating the first administrator in a freshly seeded
 * database. Environment admission belongs to the caller; this repository owns
 * the race-proof zero-operator check and the inseparable account, membership,
 * and audit writes.
 */
export class PrismaFirstAdminBootstrapRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async bootstrap(input: Readonly<{
    expectedOrganization: Readonly<{
      id: string;
      slug: string;
      name: string;
    }>;
    expectedProviderRoots: readonly Readonly<{
      id: string;
      platformKey: string;
      displayName: string;
      state: "active" | "draft";
    }>[];
    operatorId: string;
    emailNormalized: string;
    displayName: string;
    passwordHash: string;
    now: Date;
  }>): Promise<FirstAdminBootstrapResult> {
    return this.database.$transaction(async (transaction) => {
      // A transaction-scoped, process-independent mutex closes the race where
      // two local terminals both observe an empty operator table. The lock key
      // is static application text, never caller-controlled SQL.
      await transaction.$queryRaw(Prisma.sql`
        select (
          pg_advisory_xact_lock(
            hashtextextended('packscout:first-admin-bootstrap:v1', 0)
          ) is null
        ) as locked
      `);

      if (await transaction.operators.count() !== 0) {
        return { kind: "operator_already_present" } as const;
      }

      // Lock the one seeded tenant row before examining its FK-bound state.
      // Material writes in another admin/worker transaction must wait rather
      // than race this proof of a pristine normal-development seed.
      const organizations = await transaction.$queryRaw<
        Array<{ id: string; slug: string; name: string }>
      >(Prisma.sql`
        select id::text, slug, name
        from public.organizations
        order by id
        for update
      `);
      const organization = organizations[0];
      if (
        organizations.length !== 1 ||
        organization?.id !== input.expectedOrganization.id ||
        organization.slug !== input.expectedOrganization.slug ||
        organization.name !== input.expectedOrganization.name
      ) {
        return { kind: "development_seed_not_exact" } as const;
      }

      const providerRoots = await transaction.$queryRaw<Array<{
        id: string;
        organizationId: string;
        platformKey: string;
        displayName: string;
        state: string;
        activeRevisionId: string | null;
        nextRunAt: Date | null;
      }>>(Prisma.sql`
        select id::text,
               organization_id::text as "organizationId",
               platform_key as "platformKey",
               display_name as "displayName",
               state::text,
               active_revision_id::text as "activeRevisionId",
               next_run_at as "nextRunAt"
        from public.provider_sources
        order by platform_key
        for update
      `);
      const expectedProviderRoots = [...input.expectedProviderRoots].sort(
        (left, right) => left.platformKey.localeCompare(right.platformKey),
      );
      if (
        providerRoots.length !== expectedProviderRoots.length ||
        providerRoots.some((provider, index) => {
          const expected = expectedProviderRoots[index];
          return !expected ||
            provider.id !== expected.id ||
            provider.organizationId !== organization.id ||
            provider.platformKey !== expected.platformKey ||
            provider.displayName !== expected.displayName ||
            provider.state !== expected.state ||
            provider.activeRevisionId !== null ||
            provider.nextRunAt !== null;
        })
      ) {
        return { kind: "development_seed_not_exact" } as const;
      }

      // Every new organization receives one database-owned, zero-history Heat
      // checkpoint. Admit only that exact initialized shape; the checkpoint is
      // not user seed data, but omitting its proof would let a modified system
      // row masquerade as a pristine development database.
      const heatCheckpoints = await transaction.$queryRaw<Array<{
        organizationId: string;
        phase: string;
        targetPublicChangeSequence: bigint;
        processedThroughPublicChangeSequence: bigint;
        processedThroughConfirmationPublicChangeSequence: bigint;
        processedThroughConfirmationSetId: string | null;
        processedThroughRelationshipId: string | null;
        nextCatalogOrderSequence: bigint;
        targetRelationshipSourceCount: bigint;
        relationshipSourceCount: bigint;
        initialCatalogObservationCount: bigint;
        targetCatalogObservationCount: bigint | null;
        catalogObservationCount: bigint;
        failureCode: string | null;
        timestampsMatch: boolean;
      }>>(Prisma.sql`
        select organization_id::text as "organizationId",
               phase,
               target_public_change_sequence as "targetPublicChangeSequence",
               processed_through_public_change_sequence as
                 "processedThroughPublicChangeSequence",
               processed_through_confirmation_public_change_sequence as
                 "processedThroughConfirmationPublicChangeSequence",
               processed_through_confirmation_set_id::text as
                 "processedThroughConfirmationSetId",
               processed_through_relationship_id::text as
                 "processedThroughRelationshipId",
               next_catalog_order_sequence as "nextCatalogOrderSequence",
               target_relationship_source_count as
                 "targetRelationshipSourceCount",
               relationship_source_count as "relationshipSourceCount",
               initial_catalog_observation_count as
                 "initialCatalogObservationCount",
               target_catalog_observation_count as
                 "targetCatalogObservationCount",
               catalog_observation_count as "catalogObservationCount",
               failure_code as "failureCode",
               started_at is not null
                 and started_at = completed_at
                 and started_at = created_at
                 and started_at = updated_at as "timestampsMatch"
        from public.normalized_heat_relationship_backfills
        order by organization_id
        for update
      `);
      const heatCheckpoint = heatCheckpoints[0];
      if (
        heatCheckpoints.length !== 1
        || heatCheckpoint?.organizationId !== organization.id
        || heatCheckpoint.phase !== "complete"
        || heatCheckpoint.targetPublicChangeSequence !== 0n
        || heatCheckpoint.processedThroughPublicChangeSequence !== 0n
        || heatCheckpoint.processedThroughConfirmationPublicChangeSequence
          !== 0n
        || heatCheckpoint.processedThroughConfirmationSetId !== null
        || heatCheckpoint.processedThroughRelationshipId !== null
        || heatCheckpoint.nextCatalogOrderSequence !== 1n
        || heatCheckpoint.targetRelationshipSourceCount !== 0n
        || heatCheckpoint.relationshipSourceCount !== 0n
        || heatCheckpoint.initialCatalogObservationCount !== 0n
        || heatCheckpoint.targetCatalogObservationCount !== 0n
        || heatCheckpoint.catalogObservationCount !== 0n
        || heatCheckpoint.failureCode !== null
        || heatCheckpoint.timestampsMatch !== true
      ) {
        return { kind: "development_seed_not_exact" } as const;
      }

      // The canonical local seed otherwise owns rows in exactly two Prisma
      // models: organizations and provider_sources. Deriving the remaining
      // model set from the generated schema makes a newly introduced table
      // fail closed until this contract is deliberately revised.
      const materialModels = Prisma.dmmf.datamodel.models
        .map(({ name }) => name)
        .filter((name) =>
          name !== "organizations"
          && name !== "provider_sources"
          && name !== "normalized_heat_relationship_backfills"
        );
      const materialCounts = await Promise.all(
        materialModels.map(async (name) => ({
          name,
          count: await countableDelegate(transaction, name).count(),
        })),
      );
      if (materialCounts.some(({ count }) => count !== 0)) {
        return { kind: "development_seed_not_exact" } as const;
      }

      await transaction.operators.create({
        data: {
          id: input.operatorId,
          email_normalized: input.emailNormalized,
          display_name: input.displayName,
          password_hash: input.passwordHash,
          state: "active",
          created_at: input.now,
          updated_at: input.now,
        },
      });
      await transaction.operator_memberships.create({
        data: {
          organization_id: organization.id,
          operator_id: input.operatorId,
          role: "admin",
          created_at: input.now,
          updated_at: input.now,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: organization.id,
          actor_key: FIRST_ADMIN_BOOTSTRAP_ACTOR_KEY,
          action: "operator.provision",
          subject_type: "operator",
          subject_id: input.operatorId,
          outcome: "success",
          metadata_json: sanitizeAuthAuditMetadata({
            reason: "first_admin",
            role: "admin",
          }) as Prisma.InputJsonValue,
          occurred_at: input.now,
        },
      });

      return {
        kind: "created",
        organizationId: organization.id,
        operatorId: input.operatorId,
      } as const;
    }, {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      // Read committed is intentional: a second transaction may begin before
      // the first releases the advisory lock, and must take a fresh snapshot
      // afterwards so it observes the winning operator and refuses cleanly.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
}
