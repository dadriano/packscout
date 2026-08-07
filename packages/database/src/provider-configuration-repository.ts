import type {
  ProviderConfigurationSummary,
  ProviderConnectionTestSummary,
  ProviderLifecycleState,
} from "@packscout/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import {
  auditEvents,
  providerConfigRevisions,
  providerConnectionTests,
  providerCursorCheckpoints,
  providerSecretVersions,
  providerSources,
} from "./schema/index.ts";

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

export class DrizzleProviderConfigurationRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async createProvider(
    input: PersistedProviderRevisionInput & {
      readonly platformKey: string;
      readonly displayName: string;
    },
  ): Promise<ProviderCreatePersistenceResult> {
    this.assertCredentialMatchesAuth(input);
    return this.database.transaction(async (transaction) => {
      const [provider] = await transaction
        .insert(providerSources)
        .values({
          id: input.providerId,
          organizationId: input.organizationId,
          platformKey: input.platformKey,
          displayName: input.displayName,
          state: "draft",
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: [providerSources.organizationId, providerSources.platformKey],
        })
        .returning({ id: providerSources.id });
      if (!provider) return { kind: "platform_conflict" };
      await transaction.insert(providerConfigRevisions).values({
        id: input.revisionId,
        organizationId: input.organizationId,
        providerId: input.providerId,
        version: 1,
        adapterKey: input.adapterKey,
        endpointUrl: input.endpoint,
        authMode: input.authMode,
        scheduleSeconds: input.scheduleSeconds,
        staleAfterSeconds: input.staleAfterSeconds,
        createdByActorKey: input.actorKey,
        createdAt: input.now,
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
        kind: "created",
        provider: await this.requireSummary(
          transaction,
          input.organizationId,
          input.providerId,
        ),
      };
    });
  }

  async replaceRevision(
    input: PersistedProviderRevisionInput & {
      readonly expectedRevisionId: string;
    },
  ): Promise<ProviderMutationPersistenceResult> {
    this.assertCredentialMatchesAuth(input);
    return this.database.transaction(async (transaction) => {
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
      await transaction.insert(providerConfigRevisions).values({
        id: input.revisionId,
        organizationId: input.organizationId,
        providerId: input.providerId,
        version: current.revision.version + 1,
        adapterKey: input.adapterKey,
        endpointUrl: input.endpoint,
        authMode: input.authMode,
        scheduleSeconds: input.scheduleSeconds,
        staleAfterSeconds: input.staleAfterSeconds,
        createdByActorKey: input.actorKey,
        createdAt: input.now,
      });
      await this.storeCredential(transaction, input, input.now);
      await transaction
        .update(providerSources)
        .set({
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(providerSources.id, input.providerId),
            eq(providerSources.organizationId, input.organizationId),
          ),
        );
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
    });
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
    const providers = await this.database
      .select({ id: providerSources.id })
      .from(providerSources)
      .where(eq(providerSources.organizationId, organizationId))
      .orderBy(asc(providerSources.platformKey), asc(providerSources.id));
    const summaries = await Promise.all(
      providers.map(({ id }) => this.loadSummary(this.database, organizationId, id)),
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
    const [credential] = await this.database
      .select({
        ciphertext: providerSecretVersions.ciphertext,
        nonce: providerSecretVersions.nonce,
        authTag: providerSecretVersions.authTag,
        keyVersion: providerSecretVersions.keyVersion,
      })
      .from(providerSecretVersions)
      .where(
        and(
          eq(providerSecretVersions.organizationId, input.organizationId),
          eq(providerSecretVersions.providerId, input.providerId),
          eq(providerSecretVersions.revisionId, current.revision.id),
        ),
      )
      .limit(1);
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
        encryptedCredential: credential ?? null,
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
    const [revision] = await this.database
      .select({
        organizationId: providerConfigRevisions.organizationId,
        providerId: providerConfigRevisions.providerId,
        revisionId: providerConfigRevisions.id,
        platformKey: providerSources.platformKey,
        adapterKey: providerConfigRevisions.adapterKey,
        endpoint: providerConfigRevisions.endpointUrl,
        authMode: providerConfigRevisions.authMode,
        scheduleSeconds: providerConfigRevisions.scheduleSeconds,
      })
      .from(providerConfigRevisions)
      .innerJoin(
        providerSources,
        and(
          eq(providerSources.id, providerConfigRevisions.providerId),
          eq(
            providerSources.organizationId,
            providerConfigRevisions.organizationId,
          ),
        ),
      )
      .where(
        and(
          eq(providerConfigRevisions.organizationId, input.organizationId),
          eq(providerConfigRevisions.providerId, input.providerId),
          eq(providerConfigRevisions.id, input.revisionId),
        ),
      )
      .limit(1);
    if (!revision) return null;
    const [credential] = await this.database
      .select({
        ciphertext: providerSecretVersions.ciphertext,
        nonce: providerSecretVersions.nonce,
        authTag: providerSecretVersions.authTag,
        keyVersion: providerSecretVersions.keyVersion,
      })
      .from(providerSecretVersions)
      .where(
        and(
          eq(providerSecretVersions.organizationId, input.organizationId),
          eq(providerSecretVersions.providerId, input.providerId),
          eq(providerSecretVersions.revisionId, input.revisionId),
        ),
      )
      .limit(1);
    return { ...revision, encryptedCredential: credential ?? null };
  }

  async recordConnectionTest(input: {
    organizationId: string;
    providerId: string;
    revisionId: string;
    actorKey: string;
    test: ProviderConnectionTestSummary;
    testedAt: Date;
  }): Promise<ProviderConnectionTestSummary> {
    await this.database.transaction(async (transaction) => {
      const [revision] = await transaction
        .select({ id: providerConfigRevisions.id })
        .from(providerConfigRevisions)
        .where(
          and(
            eq(providerConfigRevisions.organizationId, input.organizationId),
            eq(providerConfigRevisions.providerId, input.providerId),
            eq(providerConfigRevisions.id, input.revisionId),
          ),
        )
        .limit(1);
      if (!revision) throw new Error("Provider revision is outside tenant scope.");
      await transaction.insert(providerConnectionTests).values({
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: input.revisionId,
        outcome: input.test.verdict,
        latencyMs: input.test.latencyMs,
        responseStatus: input.test.responseStatus,
        recordCountsJson: input.test.recordCounts,
        hasMore: input.test.hasMore,
        nextCursorPresent: input.test.nextCursorPresent,
        sanitizedCode: input.test.sanitizedCode,
        testedByActorKey: input.actorKey,
        testedAt: input.testedAt,
      });
      await transaction
        .update(providerConfigRevisions)
        .set({
          testedAt: input.test.verdict === "success" ? input.testedAt : null,
          testedByActorKey:
            input.test.verdict === "success" ? input.actorKey : null,
        })
        .where(eq(providerConfigRevisions.id, input.revisionId));
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
    });
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
    return this.database.transaction(async (transaction) => {
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
      await transaction
        .update(providerSources)
        .set({
          state: "active",
          activeRevisionId: current.revision.id,
          nextRunAt: input.nextRunAt,
          updatedAt: input.activatedAt,
        })
        .where(eq(providerSources.id, input.providerId));
      await transaction
        .insert(providerCursorCheckpoints)
        .values({
          configRevisionId: current.revision.id,
          organizationId: input.organizationId,
          providerId: input.providerId,
          cursor: null,
          updatedAt: input.activatedAt,
        })
        .onConflictDoNothing();
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
      return {
        kind: "updated",
        provider: await this.requireSummary(
          transaction,
          input.organizationId,
          input.providerId,
        ),
      };
    });
  }

  async transitionState(input: {
    organizationId: string;
    providerId: string;
    expectedRevisionId: string;
    targetState: "disabled" | "archived";
    actorKey: string;
    changedAt: Date;
  }): Promise<ProviderMutationPersistenceResult> {
    return this.database.transaction(async (transaction) => {
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
      await transaction
        .update(providerSources)
        .set({
          state: input.targetState,
          nextRunAt: null,
          updatedAt: input.changedAt,
        })
        .where(
          and(
            eq(providerSources.id, input.providerId),
            eq(providerSources.organizationId, input.organizationId),
          ),
        );
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
      return {
        kind: "updated",
        provider: await this.requireSummary(
          transaction,
          input.organizationId,
          input.providerId,
        ),
      };
    });
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
    database: PackscoutDatabase<TQueryResult>,
    input: PersistedProviderRevisionInput,
    retirePriorAt: Date | null,
  ): Promise<void> {
    if (retirePriorAt) {
      await database
        .update(providerSecretVersions)
        .set({ retiredAt: retirePriorAt })
        .where(
          and(
            eq(providerSecretVersions.organizationId, input.organizationId),
            eq(providerSecretVersions.providerId, input.providerId),
            sql`${providerSecretVersions.retiredAt} is null`,
          ),
        );
    }
    if (!input.encryptedCredential) return;
    await database.insert(providerSecretVersions).values({
      organizationId: input.organizationId,
      providerId: input.providerId,
      revisionId: input.revisionId,
      ciphertext: input.encryptedCredential.ciphertext,
      nonce: input.encryptedCredential.nonce,
      authTag: input.encryptedCredential.authTag,
      keyVersion: input.encryptedCredential.keyVersion,
      createdAt: input.now,
    });
  }

  private async appendAudit(
    database: PackscoutDatabase<TQueryResult>,
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
    await database.insert(auditEvents).values({
      organizationId: input.organizationId,
      actorKey: input.actorKey,
      action: input.action,
      subjectType: "provider",
      subjectId: input.providerId,
      outcome: input.outcome,
      metadataJson: { revisionId: input.revisionId, ...input.metadata },
      occurredAt: input.occurredAt,
    });
  }

  private async requireSummary(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    providerId: string,
  ): Promise<ProviderConfigurationSummary> {
    const summary = await this.loadSummary(database, organizationId, providerId);
    if (!summary) throw new Error("Provider summary could not be loaded.");
    return summary;
  }

  private async loadSummary(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    providerId: string,
  ): Promise<ProviderConfigurationSummary | null> {
    const current = await this.loadCurrent(database, organizationId, providerId);
    return current
      ? this.toSummary(database, current.provider, current.revision)
      : null;
  }

  private async loadCurrent(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    providerId: string,
  ): Promise<{
    provider: ProviderAggregateRow;
    revision: ProviderRevisionRow;
  } | null> {
    const [provider] = await database
      .select({
        id: providerSources.id,
        platformKey: providerSources.platformKey,
        displayName: providerSources.displayName,
        state: providerSources.state,
        activeRevisionId: providerSources.activeRevisionId,
        nextRunAt: providerSources.nextRunAt,
        createdAt: providerSources.createdAt,
        updatedAt: providerSources.updatedAt,
      })
      .from(providerSources)
      .where(
        and(
          eq(providerSources.organizationId, organizationId),
          eq(providerSources.id, providerId),
        ),
      )
      .limit(1);
    if (!provider) return null;
    const [revision] = await database
      .select({
        id: providerConfigRevisions.id,
        version: providerConfigRevisions.version,
        adapterKey: providerConfigRevisions.adapterKey,
        endpointUrl: providerConfigRevisions.endpointUrl,
        authMode: providerConfigRevisions.authMode,
        scheduleSeconds: providerConfigRevisions.scheduleSeconds,
        staleAfterSeconds: providerConfigRevisions.staleAfterSeconds,
        testedAt: providerConfigRevisions.testedAt,
        createdAt: providerConfigRevisions.createdAt,
      })
      .from(providerConfigRevisions)
      .where(
        and(
          eq(providerConfigRevisions.organizationId, organizationId),
          eq(providerConfigRevisions.providerId, providerId),
        ),
      )
      .orderBy(desc(providerConfigRevisions.version))
      .limit(1);
    if (!revision) return null;
    return { provider, revision };
  }

  private async lockAndLoadCurrent(
    database: PackscoutDatabase<TQueryResult>,
    organizationId: string,
    providerId: string,
  ) {
    await database.execute(
      sql`select id from ${providerSources} where ${providerSources.id} = ${providerId} and ${providerSources.organizationId} = ${organizationId} for update`,
    );
    return this.loadCurrent(database, organizationId, providerId);
  }

  private async toSummary(
    database: PackscoutDatabase<TQueryResult>,
    provider: ProviderAggregateRow,
    revision: ProviderRevisionRow,
  ): Promise<ProviderConfigurationSummary> {
    const [secret] = await database
      .select({ revisionId: providerSecretVersions.revisionId })
      .from(providerSecretVersions)
      .where(eq(providerSecretVersions.revisionId, revision.id))
      .limit(1);
    const [lastTest] = await database
      .select({
        verdict: providerConnectionTests.outcome,
        testedAt: providerConnectionTests.testedAt,
        latencyMs: providerConnectionTests.latencyMs,
        responseStatus: providerConnectionTests.responseStatus,
        recordCounts: providerConnectionTests.recordCountsJson,
        hasMore: providerConnectionTests.hasMore,
        nextCursorPresent: providerConnectionTests.nextCursorPresent,
        sanitizedCode: providerConnectionTests.sanitizedCode,
      })
      .from(providerConnectionTests)
      .where(eq(providerConnectionTests.revisionId, revision.id))
      .orderBy(desc(providerConnectionTests.testedAt), desc(providerConnectionTests.id))
      .limit(1);
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
              verdict: lastTest.verdict as ProviderConnectionTestSummary["verdict"],
              checkedAt: lastTest.testedAt.toISOString(),
              latencyMs: lastTest.latencyMs ?? 0,
              responseStatus: lastTest.responseStatus,
              recordCounts: lastTest.recordCounts,
              hasMore: lastTest.hasMore,
              nextCursorPresent: lastTest.nextCursorPresent,
              sanitizedCode: lastTest.sanitizedCode,
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
