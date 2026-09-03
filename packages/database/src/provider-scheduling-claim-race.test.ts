import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { PrismaProviderScheduleRepository } from "./provider-scheduling-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000001";
const revisionId = "30000000-0000-4000-8000-000000000001";
const previousRevisionId = "30000000-0000-4000-8000-000000000002";
const dueAt = new Date("2026-08-06T12:00:00.000Z");
const leaseExpiresAt = new Date("2026-08-06T12:00:30.000Z");

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Add an ordering expression after the unique provider ID, so it cannot
 * change candidate eligibility or order. PostgreSQL evaluates it before
 * LockRows, holding the SELECT's real READ COMMITTED snapshot at the barrier. */
function pauseBeforeSourceLock(client: PackscoutPrismaClient) {
  let intercepted = 0;
  const database = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return <T>(work: (transaction: PackscoutTransactionClient) => Promise<T>,
        options: typeof PACKSCOUT_TRANSACTION_OPTIONS) => target.$transaction(async (transaction) => {
        const isolation = await transaction.$queryRaw<Array<{ transaction_isolation: string }>>`
          show transaction_isolation
        `;
        assert.equal(isolation[0]?.transaction_isolation, "read committed");
        return work(new Proxy(transaction, {
          get(inner, key, innerReceiver) {
            if (key !== "$queryRaw") return Reflect.get(inner, key, innerReceiver);
            return (query: Prisma.Sql) => {
              if (!query.sql.includes("for update of sources skip locked")) return inner.$queryRaw(query);
              intercepted += 1;
              const order = "order by sources.next_run_at asc, sources.id asc";
              assert.equal(query.strings.filter((part) => part.includes(order)).length, 1);
              return inner.$queryRaw(Prisma.sql(query.strings.map((part) => part.replace(order,
                `${order}, (pg_advisory_xact_lock(424242) is null) /* schedule-claim-barrier */`,
              )), ...query.values));
            };
          },
        }));
      }, options);
    },
  });
  return { database, assertUsed: () => assert.equal(intercepted, 1) };
}

async function waitForClaimSnapshot(client: PackscoutPrismaClient) {
  const deadline = Date.now() + 10_000;
  do {
    const [state] = await client.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
      select exists (
        select 1 from pg_locks as locks
        where locks.database = (select oid from pg_database where datname = current_database())
          and locks.classid = 0 and locks.objid = 424242 and locks.objsubid = 1
          and locks.locktype = 'advisory' and not locks.granted
      ) as blocked
    `);
    if (state?.blocked) return;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error("Contender did not reach the schedule snapshot barrier.");
}

async function seedDueProvider(client: PackscoutPrismaClient,
  initialSchedule: "missing" | "expired" | "previous_revision") {
  await client.organizations.create({ data: { id: organizationId, slug: "claim-race", name: "Claim race" } });
  await client.provider_sources.create({ data: {
    id: providerId, organization_id: organizationId,
    platform_key: "schedule-test", display_name: "Schedule test",
  } });
  const revision = {
    organization_id: organizationId, provider_id: providerId,
    adapter_key: "http-cursor-v1", endpoint_url: "https://provider.example/feed", auth_mode: "none" as const,
    schedule_seconds: 300, stale_after_seconds: 900,
    tested_at: dueAt, tested_by_actor_key: "actor:test", created_by_actor_key: "actor:test",
  };
  await client.provider_config_revisions.create({ data: { ...revision, id: revisionId, version: 2 } });
  await client.provider_sources.update({ where: { id: providerId }, data: {
    state: "active", active_revision_id: revisionId, next_run_at: dueAt,
  } });
  if (initialSchedule === "missing") return;
  if (initialSchedule === "previous_revision") {
    await client.provider_config_revisions.create({ data: { ...revision, id: previousRevisionId, version: 1 } });
  }
  await client.provider_schedules.create({ data: {
    organization_id: organizationId, provider_id: providerId,
    config_revision_id: initialSchedule === "previous_revision" ? previousRevisionId : revisionId,
    next_due_at: dueAt, claim_owner: "old-worker",
    claim_expires_at: initialSchedule === "expired" ? dueAt : leaseExpiresAt,
    last_outcome: "coalesced", updated_at: dueAt,
  } });
}

for (const initialSchedule of ["missing", "expired", "previous_revision"] as const) {
  test(`a stale ${initialSchedule} schedule snapshot cannot overwrite a committed claim`, async () => {
    const context = await createMigratedTestDatabase();
    const ready = signal(), release = signal();
    const pending: Promise<unknown>[] = [];
    try {
      await seedDueProvider(context.client, initialSchedule);
      const controller = await context.createIndependentClient();
      const contender = pauseBeforeSourceLock(await context.createIndependentClient());
      const holding = controller.$transaction(async (transaction) => {
        await transaction.$executeRaw`select pg_advisory_xact_lock(424242)`;
        ready.resolve();
        await release.promise;
      }, PACKSCOUT_TRANSACTION_OPTIONS);
      pending.push(holding);
      await Promise.race([ready.promise, holding.then(() => { throw new Error("Barrier released early."); })]);
      const competing = new PrismaProviderScheduleRepository(contender.database).claimDueProvider({
        workerId: "contender", now: dueAt, leaseExpiresAt,
      });
      pending.push(competing);
      await waitForClaimSnapshot(context.client);

      const winner = await new PrismaProviderScheduleRepository(context.client).claimDueProvider({
        workerId: "winner", now: dueAt, leaseExpiresAt,
      });
      assert.equal(winner?.providerId, providerId);
      const committed = await context.client.provider_schedules.findUniqueOrThrow({ where: { provider_id: providerId } });
      assert.equal(committed.claim_owner, "winner");
      assert.equal(committed.config_revision_id, revisionId);

      release.resolve();
      await holding;
      assert.equal(await competing, null);
      contender.assertUsed();
      assert.deepEqual(await context.client.provider_schedules.findUniqueOrThrow({ where: { provider_id: providerId } }), committed);
      assert.equal((await context.client.provider_sources.findUniqueOrThrow({ where: { id: providerId } })).next_run_at?.getTime(), dueAt.getTime());
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await context.close();
    }
  });
}
