import type {
  ProviderConfigurationSummary,
  ProviderConnectionTestSummary,
  ProviderLifecycleState,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";
import type {
  PackscoutPrismaClient,
  PackscoutQueryClient,
} from "./database.ts";
import { isPrismaUniqueConstraintError } from "./prisma-error.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  providerPublicEntityKey,
} from "./public-change-settlement-repository.ts";

export interface StoredProviderCredential {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

export interface StoredProviderRevision {
  readonly providerId: string;
  readonly revisionId: string;
  readonly organizationId: string;
  readonly platformKey: string;
  readonly adapterKey: string;
  readonly endpoint: string;
  readonly authMode: "none" | "bearer";
  readonly scheduleSeconds: number;
  readonly encryptedCredential: StoredProviderCredential | null;
}

export interface PersistedProviderRevisionInput {
  readonly providerId: string;
  readonly revisionId: string;
  readonly organizationId: string;
  readonly displayName?: string;
  readonly adapterKey: string;
  readonly endpoint: string;
  readonly authMode: "none" | "bearer";
  readonly scheduleSeconds: number;
  readonly staleAfterSeconds: number;
  readonly encryptedCredential: StoredProviderCredential | null;
  readonly actorKey: string;
  readonly now: Date;
}

export type ProviderCreatePersistenceResult =
  | { readonly kind: "created"; readonly provider: ProviderConfigurationSummary }
  | { readonly kind: "platform_conflict" };

export type ProviderMutationPersistenceResult =
  | { readonly kind: "updated"; readonly provider: ProviderConfigurationSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict"; readonly current: ProviderConfigurationSummary }
  | { readonly kind: "connection_required" }
  | { readonly kind: "lifecycle_conflict" };

export type ProviderRevisionPersistenceLookup =
  | { readonly kind: "found"; readonly revision: StoredProviderRevision }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict"; readonly current: ProviderConfigurationSummary }
  | { readonly kind: "lifecycle_conflict" };

interface ProviderAggregateRow {
  id: string;
  organizationId: string;
  platformKey: string;
  displayName: string;
  state: ProviderLifecycleState;
  activeRevisionId: string | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ProviderRevisionRow {
  id: string;
  version: number;
  adapterKey: string;
  endpointUrl: string;
  authMode: "none" | "bearer";
  scheduleSeconds: number;
  staleAfterSeconds: number;
  testedAt: Date | null;
  createdAt: Date;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "invalid";
  }
}

export class PrismaProviderConfigurationRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async createProvider(
    input: PersistedProviderRevisionInput & {
      readonly platformKey: string;
      readonly displayName: string;
    },
  ): Promise<ProviderCreatePersistenceResult> {
    this.assertCredentialMatchesAuth(input);
    try {
      return await this.database.$transaction(async (transaction) => {
        await transaction.provider_sources.create({
          data: {
            id: input.providerId,
            organization_id: input.organizationId,
            platform_key: input.platformKey,
            display_name: input.displayName,
            state: "draft",
            created_at: input.now,
            updated_at: input.now,
          },
        });
        await transaction.provider_config_revisions.create({
          data: {
            id: input.revisionId,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            version: 1,
            adapter_key: input.adapterKey,
            endpoint_url: input.endpoint,
            auth_mode: input.authMode,
            schedule_seconds: input.scheduleSeconds,
            stale_after_seconds: input.staleAfterSeconds,
            created_by_actor_key: input.actorKey,
            created_at: input.now,
          },
        });
        await this.storeCredential(transaction, input, null);
        await this.appendAudit(transaction, {
          organizationId: input.organizationId,
          providerId: input.providerId,
          revisionId: input.revisionId,
          actorKey: input.actorKey,
          action: "provider.create",
          outcome: "success",
          occurredAt: input.now,
          metadata: { adapterKey: input.adapterKey },
        });
        return {
          kind: "created" as const,
          provider: await this.requireSummary(
            transaction,
            input.organizationId,
            input.providerId,
          ),
        };
      }, PACKSCOUT_TRANSACTION_OPTIONS);
    } catch (error) {
      if (
        isPrismaUniqueConstraintError(error, {
          fields: ["organization_id", "platform_key"],
          constraintNames: ["provider_sources_organization_platform_unique"],
        })
      ) {
        return { kind: "platform_conflict" };
      }
      throw error;
    }
  }

  async replaceRevision(
    input: PersistedProviderRevisionInput & {
      readonly expectedRevisionId: string;
    },
  ): Promise<ProviderMutationPersistenceResult> {
    this.assertCredentialMatchesAuth(input);
    return this.database.$transaction(async (transaction) => {
      const current = await this.lockAndLoadCurrent(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (!current) return { kind: "not_found" };
      if (current.provider.state === "archived") {
        return { kind: "lifecycle_conflict" };
      }
      if (current.revision.id !== input.expectedRevisionId) {
        return {
          kind: "revision_conflict",
          current: await this.toSummary(transaction, current.provider, current.revision),
        };
      }
      await transaction.provider_config_revisions.create({
        data: {
          id: input.revisionId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          version: current.revision.version + 1,
          adapter_key: input.adapterKey,
          endpoint_url: input.endpoint,
          auth_mode: input.authMode,
          schedule_seconds: input.scheduleSeconds,
          stale_after_seconds: input.staleAfterSeconds,
          created_by_actor_key: input.actorKey,
          created_at: input.now,
        },
      });
      await this.storeCredential(transaction, input, input.now);
      await transaction.provider_sources.updateMany({
        where: { id: input.providerId, organization_id: input.organizationId },
        data: {
          ...(input.displayName === undefined
            ? {}
            : { display_name: input.displayName }),
          updated_at: input.now,
        },
      });
      await this.appendAudit(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: input.revisionId,
        actorKey: input.actorKey,
        action: "provider.revision.create",
        outcome: "success",
        occurredAt: input.now,
        metadata: { adapterKey: input.adapterKey },
      });
      return {
        kind: "updated",
        provider: await this.requireSummary(
          transaction,
          input.organizationId,
          input.providerId,
        ),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async getProvider(
    organizationId: string,
    providerId: string,
  ): Promise<ProviderConfigurationSummary | null> {
    return this.loadSummary(this.database, organizationId, providerId);
  }

  async listProviders(
    organizationId: string,
  ): Promise<readonly ProviderConfigurationSummary[]> {
    const providers = await this.database.provider_sources.findMany({
      where: { organization_id: organizationId },
      orderBy: [{ platform_key: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const summaries = await Promise.all(
      providers.map(({ id }) =>
        this.loadSummary(this.database, organizationId, id),
      ),
    );
    return summaries.filter(
      (summary): summary is ProviderConfigurationSummary => summary !== null,
    );
  }

  async getRevisionForConnectionTest(input: {
    organizationId: string;
    providerId: string;
    expectedRevisionId: string;
  }): Promise<ProviderRevisionPersistenceLookup> {
    const current = await this.loadCurrent(
      this.database,
      input.organizationId,
      input.providerId,
    );
    if (!current) return { kind: "not_found" };
    if (current.provider.state === "archived") return { kind: "lifecycle_conflict" };
    if (current.revision.id !== input.expectedRevisionId) {
      return {
        kind: "revision_conflict",
        current: await this.toSummary(this.database, current.provider, current.revision),
      };
    }
    const credential = await this.database.provider_secret_versions.findFirst({
      where: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        revision_id: current.revision.id,
      },
      select: {
        ciphertext: true,
        nonce: true,
        auth_tag: true,
        key_version: true,
      },
    });
    return {
      kind: "found",
      revision: {
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: current.revision.id,
        platformKey: current.provider.platformKey,
        adapterKey: current.revision.adapterKey,
        endpoint: current.revision.endpointUrl,
        authMode: current.revision.authMode,
        scheduleSeconds: current.revision.scheduleSeconds,
        encryptedCredential: credential
          ? {
              ciphertext: credential.ciphertext,
              nonce: credential.nonce,
              authTag: credential.auth_tag,
              keyVersion: credential.key_version,
            }
          : null,
      },
    };
  }

  /**
   * Loads the exact immutable revision recorded by an already-created run.
   * Disabled or archived provider state does not invalidate bound run provenance.
   */
  async getImmutableRevisionForRuntime(input: {
    organizationId: string;
    providerId: string;
    revisionId: string;
  }): Promise<StoredProviderRevision | null> {
    const revision = await this.database.provider_config_revisions.findFirst({
      where: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        id: input.revisionId,
      },
      select: {
        id: true,
        adapter_key: true,
        endpoint_url: true,
        auth_mode: true,
        schedule_seconds: true,
      },
    });
    if (!revision) return null;
    const provider = await this.database.provider_sources.findFirst({
      where: { id: input.providerId, organization_id: input.organizationId },
      select: { platform_key: true },
    });
    if (!provider) return null;
    const credential = await this.database.provider_secret_versions.findFirst({
      where: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        revision_id: input.revisionId,
      },
      select: {
        ciphertext: true,
        nonce: true,
        auth_tag: true,
        key_version: true,
      },
    });
    return {
      organizationId: input.organizationId,
      providerId: input.providerId,
      revisionId: revision.id,
      platformKey: provider.platform_key,
      adapterKey: revision.adapter_key,
      endpoint: revision.endpoint_url,
      authMode: revision.auth_mode,
      scheduleSeconds: revision.schedule_seconds,
      encryptedCredential: credential
        ? {
            ciphertext: credential.ciphertext,
            nonce: credential.nonce,
            authTag: credential.auth_tag,
            keyVersion: credential.key_version,
          }
        : null,
    };
  }

  async recordConnectionTest(input: {
    organizationId: string;
    providerId: string;
    revisionId: string;
    actorKey: string;
    test: ProviderConnectionTestSummary;
    testedAt: Date;
  }): Promise<ProviderConnectionTestSummary> {
    await this.database.$transaction(async (transaction) => {
      const revision = await transaction.provider_config_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          id: input.revisionId,
        },
        select: { id: true },
      });
      if (!revision) throw new Error("Provider revision is outside tenant scope.");
      await transaction.provider_connection_tests.create({
        data: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          revision_id: input.revisionId,
          outcome: input.test.verdict,
          latency_ms: input.test.latencyMs,
          response_status: input.test.responseStatus,
          record_counts_json:
            input.test.recordCounts === null
              ? Prisma.DbNull
              : (input.test.recordCounts as unknown as Prisma.InputJsonValue),
          has_more: input.test.hasMore,
          next_cursor_present: input.test.nextCursorPresent,
          sanitized_code: input.test.sanitizedCode,
          tested_by_actor_key: input.actorKey,
          tested_at: input.testedAt,
        },
      });
      await transaction.provider_config_revisions.update({
        where: { id: input.revisionId },
        data: {
          tested_at: input.test.verdict === "success" ? input.testedAt : null,
          tested_by_actor_key:
            input.test.verdict === "success" ? input.actorKey : null,
        },
      });
      await this.appendAudit(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: input.revisionId,
        actorKey: input.actorKey,
        action: "provider.connection_test",
        outcome: input.test.verdict === "success" ? "success" : "failure",
        occurredAt: input.testedAt,
        metadata: {
          verdict: input.test.verdict,
          ...(input.test.sanitizedCode
            ? { sanitizedCode: input.test.sanitizedCode }
            : {}),
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
    return input.test;
  }

  async activateRevision(input: {
    organizationId: string;
    providerId: string;
    expectedRevisionId: string;
    actorKey: string;
    activatedAt: Date;
    nextRunAt: Date;
  }): Promise<ProviderMutationPersistenceResult> {
    return this.database.$transaction(async (transaction) => {
      const current = await this.lockAndLoadCurrent(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (!current) return { kind: "not_found" };
      if (current.provider.state === "archived") return { kind: "lifecycle_conflict" };
      if (current.revision.id !== input.expectedRevisionId) {
        return {
          kind: "revision_conflict",
          current: await this.toSummary(transaction, current.provider, current.revision),
        };
      }
      if (!current.revision.testedAt) return { kind: "connection_required" };
      const publicStateChanged =
        current.provider.state !== "active" ||
        current.provider.activeRevisionId !== current.revision.id;
      await transaction.provider_sources.updateMany({
        where: { id: input.providerId, organization_id: input.organizationId },
        data: {
          state: "active",
          active_revision_id: current.revision.id,
          next_run_at: input.nextRunAt,
          updated_at: input.activatedAt,
        },
      });
      await transaction.provider_cursor_checkpoints.upsert({
        where: { config_revision_id: current.revision.id },
        create: {
          config_revision_id: current.revision.id,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          cursor: null,
          updated_at: input.activatedAt,
        },
        update: {},
      });
      await this.appendAudit(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: current.revision.id,
        actorKey: input.actorKey,
        action: "provider.activate",
        outcome: "success",
        occurredAt: input.activatedAt,
        metadata: {},
      });
      if (publicStateChanged) {
        await allocatePublicChangeCauses(transaction, {
          organizationId: input.organizationId,
          changes: [{
            changeKind:
              current.provider.activeRevisionId === current.revision.id
                ? "provider_lifecycle"
                : "public_configuration",
            entityKey: providerPublicEntityKey(input.providerId),
            sourceKey: current.provider.platformKey,
            sourceRevisionKey: current.revision.id,
            metadata: {
              providerId: input.providerId,
              platformKey: current.provider.platformKey,
              state: "active",
              configurationRevisionId: current.revision.id,
            },
            occurredAt: input.activatedAt,
          }],
        });
        await advanceSettledPublicWatermark(transaction, {
          organizationId: input.organizationId,
          settledAt: input.activatedAt,
        });
      }
      return {
        kind: "updated",
        provider: await this.requireSummary(
          transaction,
          input.organizationId,
          input.providerId,
        ),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async transitionState(input: {
    organizationId: string;
    providerId: string;
    expectedRevisionId: string;
    targetState: "disabled" | "archived";
    actorKey: string;
    changedAt: Date;
  }): Promise<ProviderMutationPersistenceResult> {
    return this.database.$transaction(async (transaction) => {
      const current = await this.lockAndLoadCurrent(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (!current) return { kind: "not_found" };
      if (current.revision.id !== input.expectedRevisionId) {
        return {
          kind: "revision_conflict",
          current: await this.toSummary(transaction, current.provider, current.revision),
        };
      }
      if (current.provider.state === input.targetState) {
        return {
          kind: "updated",
          provider: await this.toSummary(transaction, current.provider, current.revision),
        };
      }
      if (current.provider.state === "archived") {
        return { kind: "lifecycle_conflict" };
      }
      await transaction.provider_sources.updateMany({
        where: { id: input.providerId, organization_id: input.organizationId },
        data: {
          state: input.targetState,
          next_run_at: null,
          updated_at: input.changedAt,
        },
      });
      await this.appendAudit(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: current.revision.id,
        actorKey: input.actorKey,
        action:
          input.targetState === "disabled"
            ? "provider.disable"
            : "provider.archive",
        outcome: "success",
        occurredAt: input.changedAt,
        metadata: { state: input.targetState },
      });
      await allocatePublicChangeCauses(transaction, {
        organizationId: input.organizationId,
        changes: [{
          changeKind: "provider_lifecycle",
          entityKey: providerPublicEntityKey(input.providerId),
          sourceKey: current.provider.platformKey,
          sourceRevisionKey: current.revision.id,
          metadata: {
            providerId: input.providerId,
            platformKey: current.provider.platformKey,
            state: input.targetState,
            configurationRevisionId: current.provider.activeRevisionId,
          },
          occurredAt: input.changedAt,
        }],
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.organizationId,
        settledAt: input.changedAt,
      });
      return {
        kind: "updated",
        provider: await this.requireSummary(
          transaction,
          input.organizationId,
          input.providerId,
        ),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private assertCredentialMatchesAuth(input: PersistedProviderRevisionInput): void {
    if (
      (input.authMode === "bearer" && input.encryptedCredential === null) ||
      (input.authMode === "none" && input.encryptedCredential !== null)
    ) {
      throw new Error("Encrypted provider credential does not match authentication mode.");
    }
  }

  private async storeCredential(
    database: PackscoutQueryClient,
    input: PersistedProviderRevisionInput,
    retirePriorAt: Date | null,
  ): Promise<void> {
    if (retirePriorAt) {
      await database.provider_secret_versions.updateMany({
        where: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          retired_at: null,
        },
        data: { retired_at: retirePriorAt },
      });
    }
    if (!input.encryptedCredential) return;
    await database.provider_secret_versions.create({
      data: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        revision_id: input.revisionId,
        ciphertext: new Uint8Array(input.encryptedCredential.ciphertext),
        nonce: new Uint8Array(input.encryptedCredential.nonce),
        auth_tag: new Uint8Array(input.encryptedCredential.authTag),
        key_version: input.encryptedCredential.keyVersion,
        created_at: input.now,
      },
    });
  }

  private async appendAudit(
    database: PackscoutQueryClient,
    input: {
      organizationId: string;
      providerId: string;
      revisionId: string;
      actorKey: string;
      action: string;
      outcome: "success" | "failure";
      occurredAt: Date;
      metadata: Record<string, string>;
    },
  ): Promise<void> {
    await database.audit_events.create({
      data: {
        organization_id: input.organizationId,
        actor_key: input.actorKey,
        action: input.action,
        subject_type: "provider",
        subject_id: input.providerId,
        outcome: input.outcome,
        metadata_json: {
          revisionId: input.revisionId,
          ...input.metadata,
        },
        occurred_at: input.occurredAt,
      },
    });
  }

  private async requireSummary(
    database: PackscoutQueryClient,
    organizationId: string,
    providerId: string,
  ): Promise<ProviderConfigurationSummary> {
    const summary = await this.loadSummary(database, organizationId, providerId);
    if (!summary) throw new Error("Provider summary could not be loaded.");
    return summary;
  }

  private async loadSummary(
    database: PackscoutQueryClient,
    organizationId: string,
    providerId: string,
  ): Promise<ProviderConfigurationSummary | null> {
    const current = await this.loadCurrent(database, organizationId, providerId);
    return current
      ? this.toSummary(database, current.provider, current.revision)
      : null;
  }

  private async loadCurrent(
    database: PackscoutQueryClient,
    organizationId: string,
    providerId: string,
  ): Promise<{
    provider: ProviderAggregateRow;
    revision: ProviderRevisionRow;
  } | null> {
    const providerRecord = await database.provider_sources.findFirst({
      where: { organization_id: organizationId, id: providerId },
      select: {
        id: true,
        organization_id: true,
        platform_key: true,
        display_name: true,
        state: true,
        active_revision_id: true,
        next_run_at: true,
        created_at: true,
        updated_at: true,
      },
    });
    if (!providerRecord) return null;
    const revisionRecord = await database.provider_config_revisions.findFirst({
      where: { organization_id: organizationId, provider_id: providerId },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        adapter_key: true,
        endpoint_url: true,
        auth_mode: true,
        schedule_seconds: true,
        stale_after_seconds: true,
        tested_at: true,
        created_at: true,
      },
    });
    if (!revisionRecord) return null;
    return {
      provider: {
        id: providerRecord.id,
        organizationId: providerRecord.organization_id,
        platformKey: providerRecord.platform_key,
        displayName: providerRecord.display_name,
        state: providerRecord.state,
        activeRevisionId: providerRecord.active_revision_id,
        nextRunAt: providerRecord.next_run_at,
        createdAt: providerRecord.created_at,
        updatedAt: providerRecord.updated_at,
      },
      revision: {
        id: revisionRecord.id,
        version: revisionRecord.version,
        adapterKey: revisionRecord.adapter_key,
        endpointUrl: revisionRecord.endpoint_url,
        authMode: revisionRecord.auth_mode,
        scheduleSeconds: revisionRecord.schedule_seconds,
        staleAfterSeconds: revisionRecord.stale_after_seconds,
        testedAt: revisionRecord.tested_at,
        createdAt: revisionRecord.created_at,
      },
    };
  }

  private async lockAndLoadCurrent(
    database: PackscoutQueryClient,
    organizationId: string,
    providerId: string,
  ) {
    await database.$queryRaw(
      Prisma.sql`
        select id
        from provider_sources
        where id = ${providerId}::uuid
          and organization_id = ${organizationId}::uuid
        for update
      `,
    );
    return this.loadCurrent(database, organizationId, providerId);
  }

  private async toSummary(
    database: PackscoutQueryClient,
    provider: ProviderAggregateRow,
    revision: ProviderRevisionRow,
  ): Promise<ProviderConfigurationSummary> {
    const secret = await database.provider_secret_versions.findFirst({
      where: {
        organization_id: provider.organizationId,
        provider_id: provider.id,
        revision_id: revision.id,
      },
      select: { revision_id: true },
    });
    const lastTest = await database.provider_connection_tests.findFirst({
      where: {
        organization_id: provider.organizationId,
        provider_id: provider.id,
        revision_id: revision.id,
      },
      orderBy: [{ tested_at: "desc" }, { id: "desc" }],
      select: {
        outcome: true,
        tested_at: true,
        latency_ms: true,
        response_status: true,
        record_counts_json: true,
        has_more: true,
        next_cursor_present: true,
        sanitized_code: true,
      },
    });
    return {
      id: provider.id,
      platformKey: provider.platformKey,
      displayName: provider.displayName,
      state: provider.state,
      latestRevision: {
        id: revision.id,
        version: revision.version,
        adapterKey: revision.adapterKey,
        endpoint: revision.endpointUrl,
        endpointHost: endpointHost(revision.endpointUrl),
        authMode: revision.authMode,
        hasBearerSecret: Boolean(secret),
        scheduleSeconds: revision.scheduleSeconds,
        staleAfterSeconds: revision.staleAfterSeconds,
        testedAt: revision.testedAt?.toISOString() ?? null,
        createdAt: revision.createdAt.toISOString(),
        lastConnectionTest: lastTest
          ? {
              verdict: lastTest.outcome as ProviderConnectionTestSummary["verdict"],
              checkedAt: lastTest.tested_at.toISOString(),
              latencyMs: lastTest.latency_ms ?? 0,
              responseStatus: lastTest.response_status,
              recordCounts:
                lastTest.record_counts_json as ProviderConnectionTestSummary["recordCounts"],
              hasMore: lastTest.has_more,
              nextCursorPresent: lastTest.next_cursor_present,
              sanitizedCode: lastTest.sanitized_code,
            }
          : null,
      },
      activeRevisionId: provider.activeRevisionId,
      nextRunAt: provider.nextRunAt?.toISOString() ?? null,
      createdAt: provider.createdAt.toISOString(),
      updatedAt: provider.updatedAt.toISOString(),
    };
  }
}
