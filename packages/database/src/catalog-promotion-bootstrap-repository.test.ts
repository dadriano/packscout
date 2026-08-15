import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PrismaCatalogPromotionRepository,
  PromotionLedgerError,
  type PromotionOperationInput,
} from "./catalog-promotion-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "92000000-0000-4000-8000-000000000001";
const otherOrganizationId = "92000000-0000-4000-8000-000000000002";
const deploymentKey = "convex-production-us";
const laneKey = "catalog";
const publicationIdentity = "92333333-3333-4333-8333-333333333333";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isLedgerError(code: PromotionLedgerError["code"]): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PromotionLedgerError);
    assert.equal(error.code, code);
    return true;
  };
}

async function createOrganization(
  client: PackscoutPrismaClient,
  id = organizationId,
  slug = "promotion-bootstrap",
): Promise<void> {
  await client.organizations.create({ data: { id, slug, name: slug } });
}

function repository(client: PackscoutPrismaClient, id = organizationId) {
  return new PrismaCatalogPromotionRepository(client, {
    organizationId: id,
    deploymentKey,
  });
}

async function createUnverifiedLane(
  target: PrismaCatalogPromotionRepository,
  watermark: bigint,
): Promise<void> {
  await target.coalesceSettledWatermark({
    laneKey,
    settledWatermark: watermark,
    settledAt: new Date("2026-08-15T17:00:00.000Z"),
    delayedVendorCount: 0,
  });
}

async function insertTerminalAttempt(input: {
  client: PackscoutPrismaClient;
  state: "published" | "unchanged";
  watermark: bigint;
  receiptBody: string;
  receiptSha256?: string;
  terminalAt?: Date;
}): Promise<void> {
  const terminalAt = input.terminalAt ?? new Date("2026-08-15T17:00:01.000Z");
  await input.client.promotion_attempts.create({
    data: {
      organization_id: organizationId,
      deployment_key: deploymentKey,
      lane_key: laneKey,
      target_watermark: input.watermark,
      state: input.state,
      content_identity: "a".repeat(64),
      publication_identity: publicationIdentity,
      terminal_receipt_body: input.receiptBody,
      terminal_receipt_sha256: input.receiptSha256 ?? digest(input.receiptBody),
      terminal_at: terminalAt,
      created_at: terminalAt,
      updated_at: terminalAt,
    },
  });
}

test("fresh bootstrap state is tenant-bound and empty verification is durable", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    await createOrganization(harness.client, otherOrganizationId, "other-bootstrap");
    const target = repository(harness.client);
    const otherTenant = repository(harness.client, otherOrganizationId);

    assert.equal(await target.loadBootstrapState(laneKey), "unverified");
    await createUnverifiedLane(target, 3n);
    assert.equal(await target.loadBootstrapState(laneKey), "unverified");
    assert.equal(await otherTenant.loadBootstrapState(laneKey), "unverified");

    await target.verifyBootstrap({
      laneKey,
      observedPublicationIdentity: null,
      observedWatermark: 0n,
      observedReceiptSha256: null,
      verifiedAt: new Date("2026-08-15T17:00:02.000Z"),
    });
    assert.equal(await target.loadBootstrapState(laneKey), "verified_empty");
    assert.equal(await otherTenant.loadBootstrapState(laneKey), "unverified");
  } finally {
    await harness.close();
  }
});

test("an exact published terminal receipt proves a nonempty bootstrap", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const target = repository(harness.client);
    await createUnverifiedLane(target, 7n);
    const receiptBody = '{"kind":"published","ok":true}';
    const terminalAt = new Date("2026-08-15T17:01:01.000Z");
    await insertTerminalAttempt({
      client: harness.client,
      state: "published",
      watermark: 7n,
      receiptBody,
      terminalAt,
    });

    await target.verifyBootstrap({
      laneKey,
      observedPublicationIdentity: publicationIdentity,
      observedWatermark: 7n,
      observedReceiptSha256: digest(receiptBody),
      verifiedAt: new Date("2026-08-15T17:01:02.000Z"),
    });

    assert.equal(await target.loadBootstrapState(laneKey), "verified_local");
    const health = await target.loadHealthSnapshot({
      laneKey,
      now: new Date("2026-08-15T17:01:03.000Z"),
    });
    assert.equal(health?.confirmedWatermark, 7n);
    assert.equal(health?.lastActivatedWatermark, 7n);
    assert.deepEqual(health?.lastActivatedAt, terminalAt);
    assert.equal(health?.lastUnchangedWatermark, null);
  } finally {
    await harness.close();
  }
});

test("an exact unchanged refresh receipt proves its advanced observation watermark", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const target = repository(harness.client);
    await createUnverifiedLane(target, 8n);
    const receiptBody = '{"kind":"refreshObservation","ok":true}';
    const terminalAt = new Date("2026-08-15T17:02:01.000Z");
    await insertTerminalAttempt({
      client: harness.client,
      state: "unchanged",
      watermark: 8n,
      receiptBody,
      terminalAt,
    });

    await target.verifyBootstrap({
      laneKey,
      observedPublicationIdentity: publicationIdentity,
      observedWatermark: 8n,
      observedReceiptSha256: digest(receiptBody),
      verifiedAt: new Date("2026-08-15T17:02:02.000Z"),
    });

    const health = await target.loadHealthSnapshot({
      laneKey,
      now: new Date("2026-08-15T17:02:03.000Z"),
    });
    assert.equal(await target.loadBootstrapState(laneKey), "verified_local");
    assert.equal(health?.confirmedWatermark, 8n);
    assert.equal(health?.lastActivatedWatermark, 0n);
    assert.equal(health?.lastActivatedAt, null);
    assert.equal(health?.lastUnchangedWatermark, 8n);
    assert.deepEqual(health?.lastUnchangedObservedAt, terminalAt);
  } finally {
    await harness.close();
  }
});

test("unknown or forged nonempty remote state remains unverified", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const target = repository(harness.client);
    await createUnverifiedLane(target, 5n);
    const receiptBody = '{"kind":"published","ok":true}';
    const forgedDigest = "f".repeat(64);
    await insertTerminalAttempt({
      client: harness.client,
      state: "published",
      watermark: 5n,
      receiptBody,
      receiptSha256: forgedDigest,
    });

    await assert.rejects(target.verifyBootstrap({
      laneKey,
      observedPublicationIdentity: publicationIdentity,
      observedWatermark: 5n,
      observedReceiptSha256: forgedDigest,
      verifiedAt: new Date("2026-08-15T17:03:02.000Z"),
    }), isLedgerError("PROMOTION_BOOTSTRAP_UNPROVEN"));
    assert.equal(await target.loadBootstrapState(laneKey), "unverified");
  } finally {
    await harness.close();
  }
});

test("an already-verified lane ignores a stale probe while an operation is in flight", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const target = repository(harness.client);
    await createUnverifiedLane(target, 4n);
    assert.equal(await target.loadBootstrapState(laneKey), "unverified");
    await target.verifyBootstrap({
      laneKey,
      observedPublicationIdentity: null,
      observedWatermark: 0n,
      observedReceiptSha256: null,
      verifiedAt: new Date("2026-08-15T17:04:01.000Z"),
    });
    const claim = await target.claimAttempt({
      laneKey,
      claimOwner: "startup-a",
      now: new Date("2026-08-15T17:04:02.000Z"),
      claimExpiresAt: new Date("2026-08-15T17:04:32.000Z"),
    });
    assert.ok(claim);
    const operation: PromotionOperationInput = {
      operationIndex: 0,
      operationId: `start:${publicationIdentity}`,
      operationKind: "start",
      requestPath: "/internal/data-release/v2/start",
      canonicalRequestBody: `{"operationId":"start:${publicationIdentity}"}`,
    };
    await target.persistAssembledOperations({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      now: new Date("2026-08-15T17:04:03.000Z"),
      contentIdentity: "b".repeat(64),
      publicationIdentity,
      operations: [operation],
    });
    assert.equal(await target.markOperationSent({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      sentAt: new Date("2026-08-15T17:04:04.000Z"),
    }), true);

    await target.verifyBootstrap({
      laneKey,
      observedPublicationIdentity: publicationIdentity,
      observedWatermark: 4n,
      observedReceiptSha256: "f".repeat(64),
      verifiedAt: new Date("2026-08-15T17:04:05.000Z"),
    });

    assert.equal(await target.loadBootstrapState(laneKey), "verified_empty");
    assert.equal(
      (await harness.client.promotion_attempts.findUniqueOrThrow({
        where: { id: claim.attemptId },
      })).state,
      "in_progress",
    );
    assert.equal(
      (await harness.client.promotion_operations.findFirstOrThrow({
        where: { attempt_id: claim.attemptId },
      })).state,
      "sent",
    );
  } finally {
    await harness.close();
  }
});
