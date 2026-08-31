import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { Client } from "pg";
import { PrismaClient } from "../generated/provider/index.js";
import { ProviderCanonicalInspectionRepository } from
  "../../src/provider-canonical-inspection-repository.ts";

const migration = new URL(
  "./migrations/20260831020000_provider_canonical_recency_index/migration.sql",
  import.meta.url,
);

interface QueryPlan {
  readonly "Index Name"?: string;
  readonly "Rows Removed by Filter"?: number;
  readonly Plans?: readonly QueryPlan[];
}

function planNodes(plan: QueryPlan): readonly QueryPlan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

test("canonical recency remains bounded when another kind dominates the ledger tail", async () => {
  const databaseName =
    `packscout_recency_${process.pid}_${randomBytes(5).toString("hex")}`;
  assert.match(databaseName, /^packscout_recency_[0-9]+_[0-9a-f]{10}$/u);
  const adminUrl = new URL(process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`);
  assert.match(adminUrl.protocol, /^postgresql?:$/u);
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  let created = false;
  let database: Client | undefined;
  let prisma: PrismaClient | undefined;
  try {
    await admin.query(`create database "${databaseName}"`);
    created = true;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    database = new Client({ connectionString: databaseUrl.toString() });
    await database.connect();
    // This index-only migration needs the real ledger's scalar columns and
    // existing indexes; no canonical facts or unrelated provider state.
    await database.query(`
      create table promotion_changes (
        sequence bigint primary key,
        entity_type text not null,
        entity_id uuid not null,
        entity_version bigint not null,
        operation text not null,
        changed_at timestamptz not null
      );
      create unique index promotion_changes_entity_version_operation_key
        on promotion_changes (entity_type, entity_id, entity_version, operation);
      insert into promotion_changes
      select sequence,
             case when sequence <= 1000 then 'market_event' else 'pull' end,
             md5(sequence::text)::uuid, 1, 'upsert',
             '2026-08-01T00:00:00Z'::timestamptz + sequence * interval '1 second'
      from generate_series(1, 100000) sequence;
      analyze promotion_changes;
    `);
    prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl.toString() } },
    });
    const scope = {
      organizationId: "10000000-0000-4000-8000-000000000001",
      platformKey: "provider_test",
      displayName: "Provider test",
      state: "active",
    };
    const repository = new ProviderCanonicalInspectionRepository(prisma, scope);
    const input = { ...scope, recordKind: "market_event" as const, collectedExtrema: false };
    const before = await repository.kindRecency(input);

    await database.query(await readFile(migration, "utf8"));

    assert.deepEqual(await repository.kindRecency(input), before);
    assert.equal(before.oldestAcceptedAt?.toISOString(), "2026-08-01T00:00:01.000Z");
    assert.equal(before.newestAcceptedAt?.toISOString(), "2026-08-01T00:16:40.000Z");
    assert.equal((await database.query("select count(*)::integer as count from promotion_changes"))
      .rows[0]?.count, 100000);
    for (const direction of ["asc", "desc"] as const) {
      const result = await database.query<{ "QUERY PLAN": readonly { Plan: QueryPlan }[] }>(`
        explain (analyze, format json)
        select changed_at from promotion_changes
        where entity_type = 'market_event' order by sequence ${direction} limit 1
      `);
      const nodes = planNodes(result.rows[0]!["QUERY PLAN"][0]!.Plan);
      assert.ok(nodes.some((node) =>
        node["Index Name"] === "promotion_changes_entity_sequence_idx"));
      assert.equal(nodes.reduce((sum, node) =>
        sum + (node["Rows Removed by Filter"] ?? 0), 0), 0);
    }
  } finally {
    await prisma?.$disconnect();
    await database?.end();
    if (created) await admin.query(`drop database "${databaseName}"`);
    await admin.end();
  }
});
