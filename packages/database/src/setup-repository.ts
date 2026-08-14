import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";

export class PipelineSetupRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async createOrganization(input: {
    id?: string;
    slug: string;
    name: string;
    createdAt?: Date;
  }): Promise<string> {
    const created = await this.database.organizations.create({
      data: {
        id: input.id,
        slug: input.slug,
        name: input.name,
        created_at: input.createdAt,
      },
      select: { id: true },
    });
    return created.id;
  }

  async createProviderSource(input: {
    id?: string;
    organizationId: string;
    platformKey: string;
    displayName: string;
    createdAt?: Date;
  }): Promise<string> {
    const created = await this.database.provider_sources.create({
      data: {
        id: input.id,
        organization_id: input.organizationId,
        platform_key: input.platformKey,
        display_name: input.displayName,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      },
      select: { id: true },
    });
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
    const provider = await this.database.provider_sources.findFirst({
      where: {
        id: input.providerId,
        organization_id: input.organizationId,
      },
      select: { id: true },
    });
    if (!provider) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "Provider is outside the organization scope.",
      );
    }

    const created = await this.database.provider_config_revisions.create({
      data: {
        id: input.id,
        organization_id: input.organizationId,
        provider_id: input.providerId,
        version: input.version,
        adapter_key: input.adapterKey,
        endpoint_url: input.endpointUrl,
        auth_mode: input.authMode,
        schedule_seconds: input.scheduleSeconds,
        stale_after_seconds: input.staleAfterSeconds,
        created_by_actor_key: input.createdByActorKey,
        created_at: input.createdAt,
      },
      select: { id: true },
    });
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
    await this.database.$transaction(async (transaction) => {
      const revision = await transaction.provider_config_revisions.findFirst({
        where: {
          id: input.revisionId,
          provider_id: input.providerId,
          organization_id: input.organizationId,
        },
        select: { id: true },
      });
      if (!revision) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Configuration revision is outside the organization and provider scope.",
        );
      }

      await transaction.provider_connection_tests.create({
        data: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          revision_id: input.revisionId,
          outcome: "success",
          latency_ms: input.latencyMs,
          tested_by_actor_key: input.actorKey,
          tested_at: input.testedAt,
        },
      });
      await transaction.provider_config_revisions.update({
        where: { id: input.revisionId },
        data: {
          tested_at: input.testedAt,
          tested_by_actor_key: input.actorKey,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async activateConfiguration(input: {
    organizationId: string;
    providerId: string;
    revisionId: string;
    actorKey: string;
    activatedAt: Date;
    nextRunAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        select id
        from public.provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);

      const revision = await transaction.provider_config_revisions.findFirst({
        where: {
          id: input.revisionId,
          provider_id: input.providerId,
          organization_id: input.organizationId,
        },
        select: { id: true, tested_at: true },
      });
      if (!revision) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Configuration revision is outside the organization and provider scope.",
        );
      }
      if (!revision.tested_at) {
        throw new PersistenceError(
          "CONFIG_REVISION_UNTESTED",
          "A successful connection test is required before activation.",
        );
      }

      await transaction.provider_sources.updateMany({
        where: {
          id: input.providerId,
          organization_id: input.organizationId,
        },
        data: {
          active_revision_id: input.revisionId,
          state: "active",
          next_run_at: input.nextRunAt,
          updated_at: input.activatedAt,
        },
      });
      await transaction.provider_cursor_checkpoints.createMany({
        data: [{
          config_revision_id: input.revisionId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          cursor: null,
          updated_at: input.activatedAt,
        }],
        skipDuplicates: true,
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: "provider.activate",
          subject_type: "provider",
          subject_id: input.providerId,
          outcome: "success",
          metadata_json: {},
          occurred_at: input.activatedAt,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
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

    const configuration = await this.database.provider_config_revisions.findFirst({
      where: {
        id: input.configRevisionId,
        provider_id: input.providerId,
        organization_id: input.organizationId,
      },
      select: { id: true },
    });
    if (!configuration) {
      throw new PersistenceError(
        "TENANT_SCOPE_VIOLATION",
        "Run configuration is outside the organization and provider scope.",
      );
    }

    const created = await this.database.import_runs.create({
      data: {
        id: input.id,
        organization_id: input.organizationId,
        provider_id: input.providerId,
        config_revision_id: input.configRevisionId,
        trigger: input.trigger,
        requested_by_actor_key: input.requestedByActorKey,
        state: input.state,
        requested_cursor: input.requestedCursor,
        created_at: input.createdAt,
      },
      select: { id: true },
    });
    return created.id;
  }

  async getCursorCheckpoint(input: {
    organizationId: string;
    providerId: string;
    configRevisionId: string;
  }): Promise<string | null | undefined> {
    const record = await this.database.provider_cursor_checkpoints.findFirst({
      where: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        config_revision_id: input.configRevisionId,
      },
      select: { cursor: true },
    });
    return record?.cursor;
  }
}
