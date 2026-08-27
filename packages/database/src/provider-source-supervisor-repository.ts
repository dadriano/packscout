import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import {
  lockProviderSourceSupervisorEnvironmentExclusive,
  lockProviderSourceSupervisorEpochEnvironmentExclusive,
} from "./provider-source-supervisor-environment-lock.ts";
import {
  PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION,
  PROVIDER_SOURCE_SUPERVISOR_TIMING,
} from "./provider-source-persistence-types.ts";

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

const SAFE_REASON_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export class ProviderSourceSupervisorRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async acquire(input: Readonly<{
    environmentKey: string;
    ownerKey: string;
    leaseToken: string;
    now: Date;
  }>): Promise<{ epochId: string; epochNumber: bigint; leaseExpiresAt: Date }> {
    if (!input.environmentKey.trim() || !input.ownerKey.trim()) {
      throw new TypeError("Supervisor environment and owner keys must not be blank.");
    }
    return this.database.$transaction(async (transaction) => {
      await lockProviderSourceSupervisorEnvironmentExclusive(
        transaction,
        input.environmentKey,
      );
      const databaseNow = await providerSourceTransactionTime(transaction);
      const current = await transaction.source_supervisor_epochs.findFirst({
        where: {
          environment_key: input.environmentKey,
          state: { in: ["active", "fenced_draining"] },
        },
        orderBy: { epoch_number: "desc" },
      });
      if (current && current.takeover_not_before > databaseNow) {
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Another supervisor still owns this environment.",
        );
      }
      if (current) {
        const expired = await transaction.$executeRaw(Prisma.sql`
          update public.source_supervisor_epochs
          set state = 'expired'::public.supervisor_epoch_state,
              released_at = clock_timestamp()
          where id = cast(${current.id} as uuid)
            and state in (
              'active'::public.supervisor_epoch_state,
              'fenced_draining'::public.supervisor_epoch_state
            )
            and takeover_not_before <= clock_timestamp()
        `);
        if (expired !== 1) {
          throw new PersistenceError(
            "SUPERVISOR_OWNERSHIP_LOST",
            "Another supervisor still owns this environment.",
          );
        }
      }
      const latest = await transaction.source_supervisor_epochs.findFirst({
        where: { environment_key: input.environmentKey },
        orderBy: { epoch_number: "desc" },
        select: { epoch_number: true },
      });
      const acquiredAt = await providerSourceTransactionTime(transaction);
      const leaseExpiresAt = addSeconds(
        acquiredAt,
        PROVIDER_SOURCE_SUPERVISOR_TIMING.leaseSeconds,
      );
      const epoch = await transaction.source_supervisor_epochs.create({
        data: {
          environment_key: input.environmentKey,
          epoch_number: (latest?.epoch_number ?? 0n) + 1n,
          owner_key: input.ownerKey,
          lease_token: input.leaseToken,
          acquired_at: acquiredAt,
          last_renewed_at: acquiredAt,
          lease_expires_at: leaseExpiresAt,
          takeover_not_before: addSeconds(
            leaseExpiresAt,
            PROVIDER_SOURCE_SUPERVISOR_TIMING.takeoverGraceSeconds,
          ),
        },
        select: { id: true, epoch_number: true },
      });
      return { epochId: epoch.id, epochNumber: epoch.epoch_number, leaseExpiresAt };
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async renew(input: Readonly<{
    epochId: string;
    ownerKey: string;
    leaseToken: string;
    now: Date;
  }>): Promise<Date> {
    return this.database.$transaction(async (transaction) => {
      const renewed = await transaction.$queryRaw<Array<{ leaseExpiresAt: Date }>>(Prisma.sql`
        update public.source_supervisor_epochs
        set last_renewed_at = clock_timestamp(),
            lease_expires_at = clock_timestamp()
              + (${PROVIDER_SOURCE_SUPERVISOR_TIMING.leaseSeconds} * interval '1 second'),
            takeover_not_before = clock_timestamp()
              + (${PROVIDER_SOURCE_SUPERVISOR_TIMING.leaseSeconds
                + PROVIDER_SOURCE_SUPERVISOR_TIMING.takeoverGraceSeconds} * interval '1 second')
        where id = cast(${input.epochId} as uuid)
          and owner_key = ${input.ownerKey}
          and lease_token = cast(${input.leaseToken} as uuid)
          and state = 'active'
          and lease_expires_at > clock_timestamp()
        returning lease_expires_at as "leaseExpiresAt"
      `);
      const leaseExpiresAt = renewed[0]?.leaseExpiresAt;
      if (!leaseExpiresAt) {
        throw new PersistenceError("SUPERVISOR_OWNERSHIP_LOST", "Supervisor lease was lost.");
      }
      return leaseExpiresAt;
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async fence(input: Readonly<{
    epochId: string;
    ownerKey: string;
    leaseToken: string;
    safeReasonCode: string;
    fencedAt: Date;
  }>): Promise<void> {
    if (!SAFE_REASON_CODE.test(input.safeReasonCode)) {
      throw new TypeError("Supervisor reason code is invalid.");
    }
    await this.database.$transaction(async (transaction) => {
      await lockProviderSourceSupervisorEpochEnvironmentExclusive(
        transaction,
        input.epochId,
      );
      const fenced = await transaction.$executeRaw(Prisma.sql`
        update public.source_supervisor_epochs
        set state = 'fenced_draining'::public.supervisor_epoch_state,
            fenced_at = clock_timestamp(),
            safe_reason_code = ${input.safeReasonCode}
        where id = cast(${input.epochId} as uuid)
          and owner_key = ${input.ownerKey}
          and lease_token = cast(${input.leaseToken} as uuid)
          and state = 'active'::public.supervisor_epoch_state
          and lease_expires_at > clock_timestamp()
      `);
      if (fenced !== 1) {
        const alreadyFenced = await transaction.source_supervisor_epochs
          .findFirst({
            where: {
              id: input.epochId,
              owner_key: input.ownerKey,
              lease_token: input.leaseToken,
              state: "fenced_draining",
              safe_reason_code: input.safeReasonCode,
            },
            select: { id: true },
          });
        if (alreadyFenced) return;
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Supervisor could not fence its epoch.",
        );
      }
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async release(input: Readonly<{
    epochId: string;
    ownerKey: string;
    leaseToken: string;
    releasedAt: Date;
  }>): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await lockProviderSourceSupervisorEpochEnvironmentExclusive(
        transaction,
        input.epochId,
      );
      const alreadyReleased = await transaction.source_supervisor_epochs
        .findFirst({
          where: {
            id: input.epochId,
            owner_key: input.ownerKey,
            lease_token: input.leaseToken,
            state: "released",
          },
          select: { id: true },
        });
      if (alreadyReleased) return;
      const epochs = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_supervisor_epochs
        where id = cast(${input.epochId} as uuid)
          and owner_key = ${input.ownerKey}
          and lease_token = cast(${input.leaseToken} as uuid)
          and state in ('active', 'fenced_draining')
          and lease_expires_at > clock_timestamp()
        for update
      `);
      if (!epochs[0]) {
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Supervisor epoch was already lost.",
        );
      }
      const databaseNow = await providerSourceTransactionTime(transaction);

      const activeRequests = await transaction.source_request_attempts.count({
        where: {
          supervisor_epoch_id: input.epochId,
          state: "in_flight",
        },
      });
      if (activeRequests !== 0) {
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Supervisor epoch cannot be released while requests are in flight.",
        );
      }

      const released = await transaction.source_supervisor_epochs.updateMany({
        where: {
          id: input.epochId,
          owner_key: input.ownerKey,
          lease_token: input.leaseToken,
          state: { in: ["active", "fenced_draining"] },
        },
        data: { state: "released", released_at: databaseNow },
      });
      if (released.count !== 1) {
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Supervisor epoch was already lost.",
        );
      }
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }
}
