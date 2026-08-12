import { and, eq, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { PackscoutDatabase } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  auditEvents,
  importRuns,
  organizations,
  providerConfigRevisions,
  providerConnectionTests,
  providerCursorCheckpoints,
  providerSources,
} from "./schema/index.ts";

export class PipelineSetupRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly database: PackscoutDatabase<TQueryResult>) {}

  async createOrganization(input: {
    id?: string;
    slug: string;
    name: string;
    createdAt?: Date;
  }): Promise<string> {
    const [created] = await this.database
      .insert(organizations)
      .values(input)
      .returning({ id: organizations.id });
    if (!created) throw new Error("Organization insert returned no identity.");
    return created.id;
  }

  async createProviderSource(input: {
    id?: string;
    organizationId: string;
    platformKey: string;
    displayName: string;
    createdAt?: Date;
  }): Promise<string> {
    const [created] = await this.database
      .insert(providerSources)
      .values({ ...input, updatedAt: input.createdAt })
      .returning({ id: providerSources.id });
    if (!created) throw new Error("Provider insert returned no identity.");
    return created.id;
  }

  async createConfigRevision(input: {
    id?: string;
    organizationId: string;
    providerId: string;
    version: number;
    adapterKey: string;
    endpointUrl: string;
    authMode: "none" | "bearer";
    scheduleSeconds?: number;
    staleAfterSeconds?: number;
    createdByActorKey: string;
    createdAt?: Date;
  }): Promise<string> {
    const [provider] = await this.database
      .select({ id: providerSources.id })
      .from(providerSources)
      .where(
        and(
          eq(providerSources.id, input.providerId),
          eq(providerSources.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!provider) throw new PersistenceError("TENANT_SCOPE_VIOLATION", "Provider is outside the organization scope.");
    const [created] = await this.database
      .insert(providerConfigRevisions)
      .values(input)
      .returning({ id: providerConfigRevisions.id });
    if (!created) throw new Error("Configuration revision insert returned no identity.");
    return created.id;
  }

  async recordSuccessfulConnectionTest(input: {
    organizationId: string;
    providerId: string;
    revisionId: string;
    actorKey: string;
    testedAt: Date;
    latencyMs: number;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [revision] = await transaction
        .select({ id: providerConfigRevisions.id })
        .from(providerConfigRevisions)
        .where(
          and(
            eq(providerConfigRevisions.id, input.revisionId),
            eq(providerConfigRevisions.providerId, input.providerId),
            eq(providerConfigRevisions.organizationId, input.organizationId),
          ),
        )
        .limit(1);
      if (!revision) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Configuration revision is outside the organization and provider scope.",
        );
      }
      await transaction.insert(providerConnectionTests).values({
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: input.revisionId,
        outcome: "success",
        latencyMs: input.latencyMs,
        testedByActorKey: input.actorKey,
        testedAt: input.testedAt,
      });
      await transaction
        .update(providerConfigRevisions)
        .set({ testedAt: input.testedAt, testedByActorKey: input.actorKey })
        .where(eq(providerConfigRevisions.id, input.revisionId));
    });
  }

  async activateConfiguration(input: {
    organizationId: string;
    providerId: string;
    revisionId: string;
    actorKey: string;
    activatedAt: Date;
    nextRunAt: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${providerSources} where ${providerSources.id} = ${input.providerId} and ${providerSources.organizationId} = ${input.organizationId} for update`,
      );
      const [revision] = await transaction
        .select({
          id: providerConfigRevisions.id,
          testedAt: providerConfigRevisions.testedAt,
        })
        .from(providerConfigRevisions)
        .where(
          and(
            eq(providerConfigRevisions.id, input.revisionId),
            eq(providerConfigRevisions.providerId, input.providerId),
            eq(providerConfigRevisions.organizationId, input.organizationId),
          ),
        )
        .limit(1);
      if (!revision) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Configuration revision is outside the organization and provider scope.",
        );
      }
      if (!revision.testedAt) {
        throw new PersistenceError(
          "CONFIG_REVISION_UNTESTED",
          "A successful connection test is required before activation.",
        );
      }
      await transaction
        .update(providerSources)
        .set({
          activeRevisionId: input.revisionId,
          state: "active",
          nextRunAt: input.nextRunAt,
          updatedAt: input.activatedAt,
        })
        .where(
          and(
            eq(providerSources.id, input.providerId),
            eq(providerSources.organizationId, input.organizationId),
          ),
        );
      await transaction
        .insert(providerCursorCheckpoints)
        .values({
          configRevisionId: input.revisionId,
          organizationId: input.organizationId,
          providerId: input.providerId,
          cursor: null,
          updatedAt: input.activatedAt,
        })
        .onConflictDoNothing();
      await transaction.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: "provider.activate",
        subjectType: "provider",
        subjectId: input.providerId,
        outcome: "success",
        metadataJson: {},
        occurredAt: input.activatedAt,
      });
    });
  }

  async createImportRun(input: {
    id?: string;
    organizationId: string;
    providerId: string;
    configRevisionId: string;
    trigger: "scheduled" | "manual" | "recovery";
    requestedByActorKey?: string | null;
    state?: "queued" | "running" | "succeeded" | "incomplete" | "failed";
    requestedCursor?: string | null;
    createdAt?: Date;
  }): Promise<string> {
    if (input.trigger === "manual" && !input.requestedByActorKey) {
      throw new TypeError("Manual import runs require a requested actor key.");
    }
    const [configuration] = await this.database
      .select({ id: providerConfigRevisions.id })
      .from(providerConfigRevisions)
      .where(
        and(
          eq(providerConfigRevisions.id, input.configRevisionId),
          eq(providerConfigRevisions.providerId, input.providerId),
          eq(providerConfigRevisions.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!configuration) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "Run configuration is outside the organization and provider scope.",
      );
    }
    const [created] = await this.database
      .insert(importRuns)
      .values(input)
      .returning({ id: importRuns.id });
    if (!created) throw new Error("Import run insert returned no identity.");
    return created.id;
  }

  async getCursorCheckpoint(input: {
    organizationId: string;
    providerId: string;
    configRevisionId: string;
  }): Promise<string | null | undefined> {
    const [record] = await this.database
      .select({ cursor: providerCursorCheckpoints.cursor })
      .from(providerCursorCheckpoints)
      .where(
        and(
          eq(providerCursorCheckpoints.organizationId, input.organizationId),
          eq(providerCursorCheckpoints.providerId, input.providerId),
          eq(providerCursorCheckpoints.configRevisionId, input.configRevisionId),
        ),
      )
      .limit(1);
    return record?.cursor;
  }
}
