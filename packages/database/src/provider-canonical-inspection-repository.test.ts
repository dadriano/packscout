import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalRecordKinds,
  type CanonicalRecordKind,
} from "@packscout/contracts";
import type { ProviderQueryClient } from "./provider-database.ts";
import { ProviderCanonicalInspectionRepository } from
  "./provider-canonical-inspection-repository.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const platformKey = "courtyard";
const acceptedAt = new Date("2026-08-29T18:00:00.000Z");
const sourceAt = new Date("2026-08-29T17:00:00.000Z");

function sqlText(query: unknown): string {
  const strings = (query as { readonly strings?: readonly string[] }).strings;
  return strings?.join(" ") ?? String(query);
}

function databaseFixture() {
  const countSql: string[] = [];
  const packFilters: unknown[] = [];
  const database = {
    async $queryRaw(query: unknown) {
      const sql = sqlText(query);
      countSql.push(sql);
      if (sql.includes("database_identity")) return [{ counted: 1n }];
      if (sql.includes("collectibles")) return [{ counted: 3n }];
      if (sql.includes("market_events")) return [{ counted: 6n }];
      if (sql.includes("pulls")) return [{ counted: 5n }];
      if (sql.includes("buyback_rate")) return [{ counted: 2n }];
      if (sql.includes("packscout_ev_calculated_at")) return [{ counted: 1n }];
      if (sql.includes("packs")) return [{ counted: 4n }];
      throw new Error(`unexpected count query: ${sql}`);
    },
    database_identity: {
      async findMany() {
        return [{
          provider_id: "10000000-0000-4000-8000-000000000002",
          provider_key: platformKey,
          created_at: acceptedAt,
        }];
      },
      async findFirst() {
        return {
          singleton_key: true,
          database_role: "provider",
          schema_version: "provider-v1",
          provider_id: "10000000-0000-4000-8000-000000000002",
          provider_key: platformKey,
          created_at: acceptedAt,
        };
      },
    },
    packs: {
      async findMany(input: { readonly where: unknown }) {
        packFilters.push(input.where);
        return [{
          id: "20000000-0000-4000-8000-000000000001",
          pack_key: "pack-one",
          row_version: 4n,
          source_updated_at: sourceAt,
          packscout_ev_data_as_of: sourceAt,
          updated_at: acceptedAt,
        }];
      },
      async findFirst() {
        return {
          id: "20000000-0000-4000-8000-000000000001",
          pack_key: "pack-one",
          row_version: 4n,
          price_amount: "100.00",
          price_currency: "USD",
          price_usd_amount: "100.00",
          buyback_rate: "0.85",
          buyback_source_kind: "provider_statement",
          vendor_ev_amount: "90.00",
          vendor_ev_currency: "USD",
          vendor_ev_observed_at: sourceAt,
          vendor_ev_unavailable_reason: null,
          packscout_ev_amount: "88.00",
          packscout_ev_currency: "USD",
          packscout_ev_model_version: "v1",
          packscout_ev_confidence_policy_version: "v1",
          packscout_ev_confidence: {},
          packscout_ev_data_as_of: sourceAt,
          packscout_ev_calculated_at: acceptedAt,
          packscout_ev_unavailable_reason: null,
          source_updated_at: sourceAt,
          updated_at: acceptedAt,
        };
      },
      async findUnique() {
        return null;
      },
    },
    collectibles: {
      async findMany() {
        return [{
          id: "30000000-0000-4000-8000-000000000001",
          collectible_key: "card-one",
          row_version: 2n,
          data_as_of: sourceAt,
          updated_at: acceptedAt,
        }];
      },
      async findUnique() {
        return null;
      },
    },
    pulls: {
      async findMany() {
        return [{
          id: "40000000-0000-4000-8000-000000000001",
          pull_key: "pull-one",
          row_version: 1n,
          occurred_at: sourceAt,
          updated_at: acceptedAt,
        }];
      },
      async findUnique() {
        return {
          id: "40000000-0000-4000-8000-000000000001",
          pull_key: "pull-one",
          fact_digest: "a".repeat(64),
          pack_key: "pack-one",
          pack_id: "20000000-0000-4000-8000-000000000001",
          row_version: 1n,
          occurred_at: sourceAt,
          updated_at: acceptedAt,
          items: [{
            ordinal: 0,
            collectible_key: "card-one",
            collectible_id: "30000000-0000-4000-8000-000000000001",
            quantity: 1n,
          }],
        };
      },
    },
    market_events: {
      async findMany() {
        return [{
          id: "50000000-0000-4000-8000-000000000001",
          event_key: "event-one",
          row_version: 1n,
          occurred_at: sourceAt,
          updated_at: acceptedAt,
        }];
      },
      async findUnique() {
        return null;
      },
    },
    promotion_changes: {
      async findFirst() {
        return { changed_at: acceptedAt };
      },
    },
  } as unknown as ProviderQueryClient;
  return { database, countSql, packFilters };
}

function repository(fixture = databaseFixture()) {
  return {
    fixture,
    repository: new ProviderCanonicalInspectionRepository(fixture.database, {
      organizationId,
      platformKey,
      displayName: "Courtyard",
      state: "active",
    }),
  };
}

test("the established seven kinds map only to distributed provider tables", async () => {
  const { repository: inspection, fixture } = repository();
  const counts = new Map<CanonicalRecordKind, number>();
  for (const recordKind of canonicalRecordKinds) {
    counts.set(recordKind, (await inspection.countBounded({
      organizationId,
      platformKey,
      recordKind,
      bound: 50,
    })).count);
  }

  assert.deepEqual(Object.fromEntries(counts), {
    platform: 1,
    pack: 4,
    catalog_asset: 3,
    ev_input: 2,
    pull: 5,
    market_event: 6,
    estimated_ev: 1,
  });
  assert.ok(fixture.countSql.every((sql) =>
    !/canonical_(?:entities|revisions|relationships)|provider_sources|organizations/u
      .test(sql)
  ));
});

test("typed entity pages retain the existing record-kind vocabulary", async () => {
  const { repository: inspection, fixture } = repository();
  const externalIds = new Map<CanonicalRecordKind, string | undefined>();
  for (const recordKind of canonicalRecordKinds) {
    const result = await inspection.listEntities({
      organizationId,
      platformKey,
      recordKind,
      offset: 0,
      limit: 25,
      direction: "asc",
    });
    assert.ok(result.items.every((row) => row.recordKind === recordKind));
    externalIds.set(recordKind, result.items[0]?.externalId);
  }

  assert.deepEqual(Object.fromEntries(externalIds), {
    platform: "courtyard",
    pack: "pack-one",
    catalog_asset: "card-one",
    ev_input: "pack-one",
    pull: "pull-one",
    market_event: "event-one",
    estimated_ev: "pack-one",
  });
  assert.ok(fixture.packFilters.some((where) =>
    "buyback_rate" in (where as Record<string, unknown>)
  ));
  assert.ok(fixture.packFilters.some((where) =>
    "packscout_ev_calculated_at" in (where as Record<string, unknown>)
  ));
});

test("pull detail is JSON-safe and exposes typed local relationships", async () => {
  const { repository: inspection } = repository();
  const detail = await inspection.readEntity({
    organizationId,
    platformKey,
    recordKind: "pull",
    externalId: "pull-one",
  });

  assert.ok(detail);
  assert.equal(detail.contentHash, "a".repeat(64));
  assert.equal(
    ((detail.content as { items: { quantity: unknown }[] }).items[0]?.quantity),
    "1",
  );
  assert.deepEqual(
    detail.relationships.map((relationship) => ({
      kind: relationship.relationshipKind,
      target: relationship.targetExternalId,
      resolved: relationship.resolved,
    })),
    [
      { kind: "pull_pack", target: "pack-one", resolved: true },
      { kind: "pull_item", target: "card-one", resolved: true },
    ],
  );
});
