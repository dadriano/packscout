import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { PrismaCatalogPromotionBootstrapProofRepository } from
  "./catalog-promotion-bootstrap-proof-repository.ts";
import { PrismaManifestPromotionRepository } from
  "./manifest-promotion-repository.ts";
import {
  PromotionV2PersistenceError,
} from "./promotion-v2-types.ts";
import { PrismaProviderPromotionRepository } from
  "./provider-promotion-repository.ts";
import {
  emptyCatalogPromotionBootstrapEvidence,
  providerPublicationFixture,
  seedPromotionV2AuthoritativeConfiguration,
} from "./promotion-v2-test-fixtures.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "5a000000-0000-4000-8000-000000000041";
const deploymentKey = "promotion-v2-proof-revisions";
const startedAt = new Date("2026-08-16T20:00:00.000Z");

function at(milliseconds: number): Date {
  return new Date(startedAt.getTime() + milliseconds);
}

test("configured-set reproof is append-only and zero-send stale work becomes N+1", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "promotion-v2-proof-revisions",
        name: "Promotion V2 Proof Revisions",
      },
    });
    await seedPromotionV2AuthoritativeConfiguration(
      harness, organizationId, ["alpha"], startedAt,
    );
    const bootstrap = new PrismaCatalogPromotionBootstrapProofRepository(
      harness.client,
      { organizationId, deploymentKey },
    );
    assert.equal(await bootstrap.loadState(), "unverified");
    const firstEvidence = await emptyCatalogPromotionBootstrapEvidence({
      platformKeys: ["alpha"],
      operationTag: "revision-1",
      observedAt: at(1_000),
    });
    await bootstrap.verifyEmpty({
      ...firstEvidence,
      verifiedAt: at(1_000),
    });
    assert.equal(await bootstrap.loadState(), "verified_empty");
    const firstProof = await bootstrap.loadProof();
    assert.equal(firstProof?.proofRevision, 1n);
    assert.deepEqual(firstProof?.providers.map(({ platformKey }) => platformKey),
      ["alpha"]);
    assert.equal(
      firstProof?.activeStateRequestBody,
      firstEvidence.activeStateRequestBody,
    );

    const provider = new PrismaProviderPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
      platformKey: "alpha",
    });
    const publication = await providerPublicationFixture();
    await provider.enqueueEvaluation({
      checkpoint: publication.checkpoint,
      requestedAt: at(2_000),
    });
    const providerClaim = await provider.claim({
      workerId: "provider-before-reproof",
      now: at(2_000),
      leaseExpiresAt: at(62_000),
    });
    assert.ok(providerClaim);

    const manifest = new PrismaManifestPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    await manifest.enqueueEvaluation({
      cause: "configuration_settled",
      causeIdentity: "before-reproof",
      requestedAt: at(2_000),
    });
    const manifestClaim = await manifest.claim({
      workerId: "manifest-before-reproof",
      now: at(2_000),
      leaseExpiresAt: at(62_000),
    });
    assert.ok(manifestClaim);

    await seedPromotionV2AuthoritativeConfiguration(
      harness, organizationId, ["alpha", "beta"], at(3_000), 2,
    );
    assert.equal(await bootstrap.loadState(), "reproof_required");
    assert.equal(await provider.claim({
      workerId: "provider-stale-zero-send",
      now: at(63_000),
      leaseExpiresAt: at(123_000),
    }), null);
    assert.equal(await manifest.claim({
      workerId: "manifest-stale-zero-send",
      now: at(63_000),
      leaseExpiresAt: at(123_000),
    }), null);
    const staleProvider = await harness.client.provider_promotion_attempts
      .findUniqueOrThrow({ where: { id: providerClaim.attemptId } });
    const staleManifest = await harness.client.manifest_promotion_attempts
      .findUniqueOrThrow({ where: { id: manifestClaim.attemptId } });
    assert.equal(staleProvider.state, "superseded");
    assert.equal(staleManifest.state, "superseded");
    assert.equal((await harness.client.provider_promotion_lanes.findUniqueOrThrow({
      where: {
        organization_id_deployment_key_platform_key: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
          platform_key: "alpha",
        },
      },
    })).requested_evaluation_sequence, 2n);
    assert.equal((await harness.client.manifest_promotion_lanes.findUniqueOrThrow({
      where: {
        organization_id_deployment_key: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
        },
      },
    })).requested_evaluation_sequence, 2n);

    const partialEvidence = await emptyCatalogPromotionBootstrapEvidence({
      platformKeys: ["alpha"],
      operationTag: "partial-revision-2",
      observedAt: at(64_000),
    });
    await assert.rejects(
      () => bootstrap.verifyEmpty({
        ...partialEvidence,
        verifiedAt: at(64_000),
      }),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_BOOTSTRAP_UNPROVEN",
    );
    assert.equal(await harness.client.catalog_promotion_bootstrap_proofs.count({
      where: { organization_id: organizationId, deployment_key: deploymentKey },
    }), 1);

    const secondEvidence = await emptyCatalogPromotionBootstrapEvidence({
      platformKeys: ["alpha", "beta"],
      operationTag: "revision-2",
      observedAt: at(65_000),
    });
    await bootstrap.verifyEmpty({
      ...secondEvidence,
      verifiedAt: at(65_000),
    });
    assert.equal(await bootstrap.loadState(), "verified_empty");
    const secondProof = await bootstrap.loadProof();
    assert.equal(secondProof?.proofRevision, 2n);
    assert.deepEqual(secondProof?.providers.map(({ platformKey }) => platformKey),
      ["alpha", "beta"]);
    assert.equal(
      secondProof?.activeStateReceiptBody,
      secondEvidence.activeStateReceiptBody,
    );
    assert.equal(await harness.client.catalog_promotion_bootstrap_proofs.count({
      where: { organization_id: organizationId, deployment_key: deploymentKey },
    }), 2);
    assert.equal(
      await harness.client.catalog_promotion_bootstrap_provider_proofs.count({
        where: { organization_id: organizationId, deployment_key: deploymentKey },
      }),
      3,
    );

    const providerAfterReproof = await provider.claim({
      workerId: "provider-after-reproof",
      now: at(66_000),
      leaseExpiresAt: at(126_000),
    });
    const manifestAfterReproof = await manifest.claim({
      workerId: "manifest-after-reproof",
      now: at(66_000),
      leaseExpiresAt: at(126_000),
    });
    assert.equal(providerAfterReproof?.evaluationSequence, 2n);
    assert.equal(manifestAfterReproof?.evaluationSequence, 2n);
    const currentAttempts = await harness.client.$queryRaw<Array<{
      lane: string;
      proofRevision: bigint;
    }>>(Prisma.sql`
      select 'provider'::text as lane,
             bootstrap_proof_revision as "proofRevision"
      from public.provider_promotion_attempts
      where id = cast(${providerAfterReproof!.attemptId} as uuid)
      union all
      select 'manifest'::text as lane,
             bootstrap_proof_revision as "proofRevision"
      from public.manifest_promotion_attempts
      where id = cast(${manifestAfterReproof!.attemptId} as uuid)
      order by lane
    `);
    assert.deepEqual(currentAttempts.map(({ proofRevision }) => proofRevision),
      [2n, 2n]);

    await harness.client.$executeRaw(Prisma.sql`
      insert into public.catalog_promotion_bootstrap_proofs (
        organization_id, deployment_key, proof_revision, proof_kind,
        active_state_request_body, active_state_request_sha256,
        active_state_receipt_body, active_state_receipt_sha256,
        active_state_response_body, active_state_response_sha256,
        manifest_definition_request_body, manifest_definition_request_sha256,
        manifest_terminal_request_body, manifest_terminal_request_sha256,
        manifest_receipt_body, manifest_receipt_sha256,
        manifest_response_body, manifest_response_sha256,
        active_state_body, active_state_sha256, verified_at
      )
      select organization_id, deployment_key, 99, proof_kind,
             '{}', active_state_request_sha256,
             active_state_receipt_body, active_state_receipt_sha256,
             active_state_response_body, active_state_response_sha256,
             manifest_definition_request_body,
             manifest_definition_request_sha256,
             manifest_terminal_request_body, manifest_terminal_request_sha256,
             manifest_receipt_body, manifest_receipt_sha256,
             manifest_response_body, manifest_response_sha256,
             active_state_body, active_state_sha256, verified_at
      from public.catalog_promotion_bootstrap_proofs
      where organization_id = cast(${organizationId} as uuid)
        and deployment_key = ${deploymentKey} and proof_revision = 2
    `);
    await harness.client.manifest_promotion_lanes.update({
      where: {
        organization_id_deployment_key: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
        },
      },
      data: { current_bootstrap_proof_revision: 99n },
    });
    await assert.rejects(
      () => bootstrap.loadState(),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_BOOTSTRAP_UNPROVEN",
    );
  } finally {
    await harness.close();
  }
});

test("persisted bootstrap provider-set corruption is a hard unproven state", async () => {
  const harness = await createMigratedTestDatabase();
  const corruptOrganizationId = "5a000000-0000-4000-8000-000000000042";
  try {
    await harness.client.organizations.create({
      data: {
        id: corruptOrganizationId,
        slug: "promotion-v2-corrupt-anchor",
        name: "Promotion V2 Corrupt Anchor",
      },
    });
    await seedPromotionV2AuthoritativeConfiguration(
      harness, corruptOrganizationId, ["alpha"], startedAt,
    );
    const bootstrap = new PrismaCatalogPromotionBootstrapProofRepository(
      harness.client,
      { organizationId: corruptOrganizationId, deploymentKey },
    );
    const evidence = await emptyCatalogPromotionBootstrapEvidence({
      platformKeys: ["alpha"],
      operationTag: "corrupt-anchor",
      observedAt: at(1_000),
    });
    await bootstrap.verifyEmpty({ ...evidence, verifiedAt: at(1_000) });
    await harness.client.manifest_promotion_lanes.update({
      where: {
        organization_id_deployment_key: {
          organization_id: corruptOrganizationId,
          deployment_key: deploymentKey,
        },
      },
      data: { bootstrap_provider_set_sha256: "f".repeat(64) },
    });
    await assert.rejects(
      () => bootstrap.loadState(),
      (error) => error instanceof PromotionV2PersistenceError &&
        error.code === "PROMOTION_V2_BOOTSTRAP_UNPROVEN",
    );
  } finally {
    await harness.close();
  }
});
