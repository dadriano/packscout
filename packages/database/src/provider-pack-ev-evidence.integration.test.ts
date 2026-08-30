import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  providerPackEvEvidenceV1Schema,
  type ProviderPackEvEvidenceV1,
} from "@packscout/contracts";
import { Pool } from "pg";
import { PrismaClient } from "../prisma/generated/provider/index.js";
import {
  ProviderCanonicalInputError,
  ProviderCanonicalWriteConflictError,
  type CanonicalJsonObject,
  type PackWriteInput,
} from "./provider-canonical-contract.ts";
import { ProviderCanonicalRepository } from "./provider-canonical-repository.ts";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";

const execFileAsync = promisify(execFile);
const sourceAt = "2026-08-29T12:00:00.000Z";
const collectedAt = "2026-08-29T12:00:01.000Z";
const providerId = randomUUID();
const organizationId = randomUUID();

async function postgresBinDirectory(): Promise<string | null> {
  const configured = process.env.PACKSCOUT_TEST_POSTGRES_BIN_DIRECTORY;
  const directories = configured ? [configured] : [
    await execFileAsync("pg_config", ["--bindir"]).then(({ stdout }) => stdout.trim()).catch(() => ""),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/lib/postgresql/16/bin",
  ];
  for (const directory of directories.filter(Boolean)) {
    try {
      await Promise.all([access(join(directory, "initdb")), access(join(directory, "pg_ctl"))]);
      return directory;
    } catch (error) {
      if (configured) throw error;
    }
  }
  return null;
}

/** An isolated socket-only cluster permits the real immutable provider identity. */
async function createHarness(binDirectory: string) {
  // /tmp keeps the Unix socket below PostgreSQL's path length limit on macOS.
  const directory = await mkdtemp("/tmp/packscout-ev-test-");
  const dataDirectory = join(directory, "data");
  const pgCtl = join(binDirectory, "pg_ctl");
  const user = "packscout_ev_test";
  let started = false;
  let client: PrismaClient | undefined;
  let admin: Pool | undefined;
  async function close() {
    await client?.$disconnect();
    await admin?.end();
    if (started) {
      await execFileAsync(pgCtl, ["stop", "-D", dataDirectory, "-m", "fast", "-w", "-t", "15"]);
      started = false;
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await execFileAsync(join(binDirectory, "initdb"), [
      "-D", dataDirectory, "-A", "trust", "-U", user, "--no-locale", "-E", "UTF8",
    ]);
    await execFileAsync(pgCtl, [
      "start", "-D", dataDirectory, "-l", join(directory, "postgres.log"), "-w", "-t", "15",
      "-o", `-F -k ${directory} -c listen_addresses='' -c unix_socket_permissions=0700`,
    ]);
    started = true;
    admin = new Pool({ host: directory, user, database: "postgres", port: 5432, max: 1 });
    await admin.query('create database "packscout_clutchpacks"');
    const databaseUrl = new URL(`postgresql://${user}@localhost:5432/packscout_clutchpacks`);
    databaseUrl.searchParams.set("host", directory);
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url)),
      "migrate", "deploy", "--schema",
      fileURLToPath(new URL("../prisma/provider/schema.prisma", import.meta.url)),
    ], { env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: databaseUrl.toString() } });
    client = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
    await initializeProviderDatabaseIdentity({ client, providerId, providerKey: "clutchpacks" });
    return { client, repository: new ProviderCanonicalRepository(client), close };
  } catch (error) {
    await close();
    throw error;
  }
}

function evidence(recordId: string): ProviderPackEvEvidenceV1 {
  return providerPackEvEvidenceV1Schema.parse({
    schemaVersion: "provider_pack_ev_evidence_v1",
    organizationId, providerId, providerKey: "clutchpacks", providerRecordId: recordId,
    recordIdScopeKey: "catalog-pack-v1", sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-clutchpacks-distributed-adapter-v1",
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: "clutchpacks-provider-observation", mapperVersion: "1",
    identityNamespaceKey: "dataforrest-clutchpacks-records-v1", effectiveAt: sourceAt, collectedAt,
    price: { state: "present", value: { amount: 100, currency: "USD" } },
    buybackPercent: { state: "present", value: 90 },
    drawCount: { state: "present", value: 1 },
    evInput: {
      state: "present",
      value: {
        approved: true, currency: "USD", unitBasis: "per_pack", drawCount: 1,
        buybackPercent: 90, totalQuantity: 4,
        buckets: [
          { bucketId: "common", label: "Common", probability: 0.75, quantity: 3, lowerValue: 20, upperValue: 100 },
          { bucketId: "chase", label: "Chase", probability: 0.25, quantity: 1, lowerValue: 100, upperValue: 1000 },
        ],
      },
    },
  });
}

function packInput(recordId: string): PackWriteInput {
  return {
    packKey: `pack:${recordId}`, categoryId: null, familyKey: null,
    displayName: "Retained evidence pack", description: null, packFormat: "repack",
    availability: "available", contentEvidence: "unknown", totalInventory: null, remainingInventory: null,
    priceAmount: "100", priceCurrency: "USD", priceUsdAmount: "100", priceUnavailableReason: null,
    buybackRate: "0.9", buybackSourceKind: "provider_statement", vendorEvAmount: "100",
    vendorEvCurrency: "USD", vendorEvObservedAt: new Date(sourceAt), vendorEvUnavailableReason: null,
    packscoutEvAmount: null, packscoutEvCurrency: null, packscoutEvModelVersion: "not_calculated",
    packscoutEvConfidencePolicyVersion: "not_calculated", packscoutEvConfidence: null,
    packscoutEvDataAsOf: null, packscoutEvCalculatedAt: null, packscoutEvUnavailableReason: "not_calculated",
    primaryImageUrl: null, primaryImageAlt: null, listingUrl: null,
    attributes: { existing: { owner: "canonical" } }, sourceUpdatedAt: new Date(sourceAt),
  };
}

function withEvidence(pack: PackWriteInput, value: unknown): PackWriteInput {
  return {
    ...pack,
    attributes: { ...pack.attributes, evInputEvidence: value } as CanonicalJsonObject,
  };
}

test("canonical EV evidence enrichment uses isolated PostgreSQL with the real provider identity", async (context) => {
  const binDirectory = await postgresBinDirectory();
  if (binDirectory === null) {
    context.skip("PostgreSQL initdb and pg_ctl are required for an isolated evidence database.");
    return;
  }
  const { client, repository, close } = await createHarness(binDirectory);
  const row = (pack: PackWriteInput) => client.packs.findUniqueOrThrow({ where: { pack_key: pack.packKey } });
  const ledger = () => client.promotion_changes.findMany({ orderBy: { sequence: "asc" } });
  try {
    await context.test("first attachment changes only evidence and publishes exactly one new row version", async () => {
      const input = packInput("first-attachment");
      const initial = await repository.upsertPack(input);
      const before = await row(input);
      const priorLedger = await ledger();
      const attached = await repository.upsertPack(withEvidence(input, evidence("first-attachment")));
      const after = await row(input);
      assert.deepEqual(attached, { id: initial.id, rowVersion: 2n, materialChange: true, promotionSequence: 2n });
      assert.deepEqual(after, {
        ...before, attributes: withEvidence(input, evidence("first-attachment")).attributes,
        row_version: 2n, updated_at: after.updated_at,
      });
      const changes = await ledger();
      assert.equal(changes.length, priorLedger.length + 1);
      assert.deepEqual(changes.at(-1), {
        ...changes.at(-1), sequence: 2n, entity_type: "pack", entity_id: initial.id,
        entity_version: 2n, operation: "upsert",
      });
      const originalEvidence = evidence("first-attachment");
      for (const replay of [
        originalEvidence,
        { ...originalEvidence, collectedAt: sourceAt },
        { ...originalEvidence, collectedAt: "2026-08-30T12:00:00.000Z" },
      ]) {
        assert.deepEqual(await repository.upsertPack(withEvidence(input, replay)), {
          id: initial.id, rowVersion: 2n, materialChange: false, promotionSequence: null,
        });
        assert.deepEqual(await row(input), after);
        assert.deepEqual(await ledger(), changes);
      }
    });

    await context.test("same-source conflicts cannot replace facts, pins, identity or unrelated canonical fields", async () => {
      const input = packInput("conflicts");
      const original = evidence("conflicts");
      await repository.upsertPack(withEvidence(input, original));
      const before = await row(input);
      const priorLedger = await ledger();
      assert.equal(original.evInput.state, "present");
      if (original.evInput.state !== "present") assert.fail("expected fixture odds");
      for (const changedEvidence of [
        { ...original, organizationId: randomUUID() },
        { ...original, providerId: randomUUID() },
        { ...original, providerKey: "courtyard", identityNamespaceKey: "dataforrest-courtyard-records-v1" },
        { ...original, providerRecordId: "different-pack" },
        { ...original, sourceAdapterVersion: "different-adapter" },
        { ...original, sourceTypeKey: "different-source" },
        { ...original, mapperVersion: "2" },
        { ...original, effectiveAt: "2026-08-29T11:00:00.000Z" },
        { ...original, price: { state: "present", value: { amount: 101, currency: "USD" } } },
        { ...original, buybackPercent: { state: "present", value: 91 } },
        { ...original, drawCount: { state: "present", value: 2 } },
        { ...original, evInput: { state: "present", value: { ...original.evInput.value, totalQuantity: 5 } } },
        { ...original, raw: { secret: "not-allowed" } },
        null,
      ]) {
        await assert.rejects(repository.upsertPack(withEvidence(input, changedEvidence)), ProviderCanonicalWriteConflictError);
      }
      for (const changes of [
        { displayName: "Changed name" }, { availability: "sold_out" as const },
        { priceAmount: "101" }, { buybackRate: "0.8" }, { remainingInventory: 1n },
        { attributes: { extra: "new", evInputEvidence: original } },
        { attributes: input.attributes },
      ]) {
        await assert.rejects(repository.upsertPack({ ...withEvidence(input, original), ...changes }), ProviderCanonicalWriteConflictError);
      }
      assert.deepEqual(await row(input), before);
      assert.deepEqual(await ledger(), priorLedger);
    });

    await context.test("first attachment rejects mismatched economics and identity", async () => {
      const input = packInput("invalid-attachment");
      const original = evidence("invalid-attachment");
      await repository.upsertPack(input);
      const before = await row(input);
      for (const changed of [
        { ...original, providerId: randomUUID() },
        { ...original, providerRecordId: "other-pack" },
        { ...original, price: { state: "present", value: { amount: 99, currency: "USD" } } },
        { ...original, buybackPercent: { state: "present", value: 80 } },
      ]) await assert.rejects(repository.upsertPack(withEvidence(input, changed)), ProviderCanonicalWriteConflictError);
      await assert.rejects(repository.upsertPack({ ...withEvidence(input, original), displayName: "Replacement" }), ProviderCanonicalWriteConflictError);
      assert.deepEqual(await row(input), before);
      await assert.rejects(repository.upsertPack(withEvidence(packInput("invalid-new"), original)), ProviderCanonicalInputError);
      assert.equal(await client.packs.count({ where: { pack_key: "pack:invalid-new" } }), 0);
    });

    await context.test("older observations remain no-ops and a newer source revision can replace evidence", async () => {
      const input = packInput("source-order");
      const initial = evidence("source-order");
      await repository.upsertPack(withEvidence(input, initial));
      const newerAt = "2026-08-30T12:00:00.000Z";
      const newer = withEvidence({ ...input, displayName: "New revision", priceAmount: "200", priceUsdAmount: "200", sourceUpdatedAt: new Date(newerAt) }, {
        ...initial, effectiveAt: newerAt, collectedAt: "2026-08-30T12:00:01.000Z",
        price: { state: "present", value: { amount: 200, currency: "USD" } },
      });
      const changed = await repository.upsertPack(newer);
      assert.equal(changed.rowVersion, 2n);
      const beforeReplay = await row(input);
      const beforeLedger = await ledger();
      assert.equal((await repository.upsertPack(withEvidence(input, initial))).materialChange, false);
      assert.deepEqual(await row(input), beforeReplay);
      assert.deepEqual(await ledger(), beforeLedger);
    });

    await context.test("unavailable normalized facts are retained without inventing economic values", async () => {
      const input = {
        ...packInput("unavailable-facts"),
        priceAmount: null, priceCurrency: null, priceUsdAmount: null,
        priceUnavailableReason: "source_unavailable", buybackRate: null, buybackSourceKind: null,
      };
      const retained = {
        ...evidence("unavailable-facts"), price: { state: "absent" },
        buybackPercent: { state: "absent" }, evInput: { state: "malformed" },
      };
      await repository.upsertPack(input);
      assert.equal((await repository.upsertPack(withEvidence(input, retained))).rowVersion, 2n);
      const stored = await row(input);
      assert.deepEqual(stored.attributes, withEvidence(input, retained).attributes);
      assert.equal(stored.price_amount, null);
      assert.equal(stored.buyback_rate, null);
      assert.equal(stored.packscout_ev_amount, null);
      assert.equal(stored.packscout_ev_calculated_at, null);
    });

    await context.test("stale expected versions and rolled-back attachments cannot advance the promotion ledger", async () => {
      const input = packInput("transaction-control");
      const original = evidence("transaction-control");
      await repository.upsertPack(input);
      const before = await row(input);
      const priorLedger = await ledger();
      await assert.rejects(repository.upsertPack({ ...withEvidence(input, original), expectedRowVersion: 0n }), ProviderCanonicalWriteConflictError);
      await assert.rejects(repository.transaction(async (canonical) => {
        await canonical.upsertPack(withEvidence(input, original));
        throw new Error("abort attachment transaction");
      }), /abort attachment transaction/u);
      assert.deepEqual(await row(input), before);
      assert.deepEqual(await ledger(), priorLedger);
      const outcomes = await Promise.allSettled([
        repository.upsertPack({ ...withEvidence(input, original), expectedRowVersion: 1n }),
        repository.upsertPack({ ...withEvidence(input, original), expectedRowVersion: 1n }),
      ]);
      assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = outcomes.find(({ status }) => status === "rejected");
      assert.ok(rejected?.status === "rejected" && rejected.reason instanceof ProviderCanonicalWriteConflictError);
      assert.equal((await row(input)).row_version, 2n);
      assert.equal((await ledger()).length, priorLedger.length + 1);
    });
  } finally {
    await close();
  }
});
