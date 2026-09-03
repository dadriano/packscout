import assert from "node:assert/strict";
import { test } from "node:test";
import { permissionsForOperatorRole } from "./auth.ts";
import {
  PACK_CATALOG_CURSOR_LIFETIME_MS,
  PACK_CATALOG_LIST_MAX_ITEMS,
  PACK_CATALOG_V1,
  PACK_CONTENT_PAGE_MAX_ITEMS,
  PACK_PUBLICATION_REPLAY_LIFETIME_MS,
  PACK_SNAPSHOT_BATCH_MAX_BYTES,
  PACK_SNAPSHOT_BATCH_MAX_ITEMS,
  PACK_SNAPSHOT_MAX_CONTENTS,
  SAVED_CATALOG_ITEM_LIMIT,
  assertPublicPackCatalogBytes,
  hashPackCatalogValue,
  packCatalogCanonicalJson,
} from "./pack-catalog-v1.ts";
import {
  activePackHeadSchema,
  alertablePublicationWorkStates,
  evaluatePublicationReplay,
  isPublicationAlertAgeEligible,
  isTerminalPublicationWork,
  packBuildRequestSchema,
  publicationOperationOutcomes,
  publicationPlannerOutcomeSchema,
  publicationReasonCodes,
  publicationReasonDefaultState,
  sharedProviderChangeDeliverySchema,
  publicationReplayRecordSchema,
  publicationWorkStates,
  terminalPublicationWorkStates,
} from "./pack-publication.ts";
import {
  normalizePublicPackSnapshotPayload,
  publicPackLifecycleSchema,
  publicPackSnapshotPayloadSchema,
} from "./pack-catalog-domain.ts";
import {
  PackCatalogCursorError,
  packCatalogQueryNames,
  packCatalogReadErrorCodes,
  packCatalogV1QueryContracts,
  readPackCatalogCursor,
  savedCatalogErrorCodes,
  savedCatalogItemIdsSchema,
  savedCatalogItemsV1Contract,
} from "./pack-catalog-query.ts";
import {
  canReadPackPublicationStatus,
  packCatalogAdminPermissions,
  packRecoveryOperationSchema,
  trustedPackCatalogServiceIdentityAllows,
} from "./pack-catalog-operations.ts";
import {
  createPackCatalogV1Fixture,
  packCatalogFixtureIds,
  sealFixturePack,
} from "./pack-catalog-fixtures.ts";

const SIGNING_KEY = new Uint8Array(32).fill(17);
const NOW = "2026-09-03T18:10:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

async function expectCursorExpired(run: () => Promise<unknown>) {
  await assert.rejects(run, (error) =>
    error instanceof PackCatalogCursorError && error.code === "CURSOR_EXPIRED"
  );
}

test("Native pack catalog contract matrix", async (context) => {
  const fixture = await createPackCatalogV1Fixture(SIGNING_KEY);

  await context.test("one pack advances without changing another pack", async () => {
    const packBBefore = structuredClone(fixture.packs.packB);
    const headBBefore = structuredClone(fixture.heads.packB);
    const updatedHeadA = activePackHeadSchema.parse({
      ...fixture.heads.packA,
      generation: 2,
      latestAcceptedPackPublicationSequence: "3",
      activeSnapshot: fixture.packs.packAUpdate.snapshot.identity,
      previousSnapshot: fixture.packs.packA.snapshot.identity,
      indexableSummary: fixture.packs.packAUpdate.snapshot.payload.summaryProjection,
      activatedAt: "2026-09-03T18:02:00.000Z",
    });

    assert.notEqual(updatedHeadA.activeSnapshot.contentSha256, fixture.heads.packA.activeSnapshot.contentSha256);
    assert.equal(updatedHeadA.publicRepackId, fixture.heads.packA.publicRepackId);
    assert.deepEqual(fixture.packs.packB, packBBefore);
    assert.deepEqual(fixture.heads.packB, headBBefore);
    assert.equal(fixture.packs.packA.snapshot.payload.economicsSha256, fixture.packs.packAUpdate.snapshot.payload.economicsSha256);
    assert.equal(fixture.packs.packAUpdate.snapshot.payload.lifecycleFreeze?.previousSnapshotId, fixture.packs.packA.snapshot.identity.publicPackSnapshotId);

    const permuted = structuredClone(fixture.packs.packA.snapshot.payload);
    permuted.contents.reverse();
    permuted.collectibleProfileSnapshotIds.reverse();
    permuted.valuationDependencyIdentities.reverse();
    permuted.actions.reverse();
    permuted.searchProjection.aliases.reverse();
    const resealed = await sealFixturePack(normalizePublicPackSnapshotPayload(permuted));
    assert.equal(resealed.snapshot.identity.contentSha256, fixture.packs.packA.snapshot.identity.contentSha256);
    assert.equal(resealed.canonicalBytes, fixture.packs.packA.canonicalBytes);
  });

  await context.test("complete snapshots reject mixed or protected inputs", async () => {
    const valid = fixture.packs.packA.snapshot.payload;
    assert.equal(valid.contents.length, valid.contentCount);
    assert.equal(valid.contents.reduce((sum, item) => sum + item.probabilityMicros, 0), 1_000_000);
    assert.equal(valid.summaryProjection.publicRepackId, valid.publicRepackId);
    assert.equal(valid.topChase?.publicCollectibleId, packCatalogFixtureIds.collectibleA);
    assert.equal(fixture.packs.packB.snapshot.payload.ev.status, "unavailable");
    assert.equal(fixture.packs.packA.descriptor.batches[0]?.recordCount, valid.contents.length);
    assert.equal(fixture.provider.batch.profile.identity.publicProfileSnapshotId, fixture.provider.profile.identity.publicProfileSnapshotId);

    const missingContents = structuredClone(valid);
    missingContents.contents = [];
    await assert.rejects(() => sealFixturePack(missingContents));

    const invalidOdds = structuredClone(valid);
    invalidOdds.contents[0]!.probabilityMicros -= 1;
    await assert.rejects(() => sealFixturePack(invalidOdds));

    const staleProfile = structuredClone(valid);
    staleProfile.collectibleProfileSnapshotIds = staleProfile.collectibleProfileSnapshotIds.slice(1);
    await assert.rejects(() => sealFixturePack(staleProfile));

    const mismatchedEv = structuredClone(valid);
    mismatchedEv.evInputsSha256 = "0".repeat(64);
    await assert.rejects(() => sealFixturePack(mismatchedEv));

    const technicalFailure = { ...structuredClone(valid), ev: { status: "technical_failure" } };
    assert.equal(publicPackSnapshotPayloadSchema.safeParse(technicalFailure).success, false);
    const expiredEv = structuredClone(valid);
    expiredEv.ev.validUntil = expiredEv.ev.evaluatedAt;
    assert.equal(publicPackSnapshotPayloadSchema.safeParse(expiredEv).success, false);
    assert.throws(() => assertPublicPackCatalogBytes({ rawProviderPayload: "secret" }), /protected field/u);
    assert.throws(() => packCatalogCanonicalJson({ unsafe: Number.MAX_SAFE_INTEGER + 1 }), /safe integers/u);
    assert.equal(publicPackSnapshotPayloadSchema.safeParse({ ...valid, rawResponse: "private" }).success, false);
  });

  await context.test("lifecycle, chase, identity, and profile rules are explicit", async () => {
    assert.equal(fixture.lifecycleCases.length, 8);
    for (const state of fixture.lifecycleCases) assert.equal(publicPackLifecycleSchema.safeParse(state).success, true);
    assert.equal(publicPackLifecycleSchema.safeParse({
      availability: "unknown",
      retirement: "retired",
      availabilityEvidence: { kind: "canonical_state", canonicalState: "unknown", sourceIdentity: "outage" },
      retirementEvidence: { kind: "not_retired" },
    }).success, false);
    assert.equal(fixture.packs.packA.snapshot.payload.actions[0]?.enabled, true);
    assert.equal(fixture.packs.packB.snapshot.payload.actions[0]?.enabled, false);

    const tied = structuredClone(fixture.packs.packA.snapshot.payload);
    for (const item of tied.contents) {
      if (item.valuation.status === "available") item.valuation.amount.minorUnits = 20_000;
    }
    tied.topChase = {
      publicCollectibleId: packCatalogFixtureIds.collectibleA,
      valuationIdentity: tied.contents[0]!.valuation.valuationIdentity,
      amount: { currency: "USD", minorUnits: 20_000 },
    };
    tied.summaryProjection.topChase = tied.topChase;
    assert.equal(publicPackSnapshotPayloadSchema.safeParse(tied).success, true);
    tied.topChase.publicCollectibleId = packCatalogFixtureIds.collectibleB;
    tied.summaryProjection.topChase = tied.topChase;
    assert.equal(publicPackSnapshotPayloadSchema.safeParse(tied).success, false);

    const required = new Set(fixture.buildRequest.requiredProfileSnapshotIds);
    assert.ok(required.has(fixture.provider.profile.identity.publicProfileSnapshotId));
    for (const item of fixture.packs.packA.snapshot.payload.contents) {
      assert.ok(required.has(item.collectibleProfileSnapshotId));
    }
    assert.equal(packBuildRequestSchema.safeParse({
      ...fixture.buildRequest,
      requiredProfileSnapshotIds: [],
    }).success, false);
    assert.equal(fixture.activationIntents[0]!.snapshot.publicPackSnapshotId, fixture.activationIntents[1]!.snapshot.publicPackSnapshotId);
    assert.notEqual(fixture.activationIntents[0]!.intentId, fixture.activationIntents[1]!.intentId);
    const sharedChange = sharedProviderChangeDeliverySchema.parse({ organizationId: packCatalogFixtureIds.organizationId, providerId: packCatalogFixtureIds.providerId, centralChangeIdentity: "central-change:9", providerChangeSequence: "99", sharedDependencies: [], payloadSha256: SHA_A, leaseIdentity: "70000000-0000-4000-8000-000000000003", acknowledgmentIdentity: null });
    assert.notEqual(sharedChange.providerChangeSequence, fixture.buildRequest.packPublicationSequence);

    const packHashes = fixture.packs.packA.snapshot.identity.contentSha256 + fixture.packs.packB.snapshot.identity.contentSha256;
    const changedProfileHash = await hashPackCatalogValue("packscout.public-profile-snapshot.v1", {
      ...fixture.provider.profile,
      displayName: "Renamed Provider",
    });
    assert.notEqual(changedProfileHash, fixture.provider.profile.identity.contentSha256);
    assert.equal(fixture.packs.packA.snapshot.identity.contentSha256 + fixture.packs.packB.snapshot.identity.contentSha256, packHashes);
  });

  await context.test("six native queries and live signed cursors stay bound", async () => {
    assert.deepEqual([...packCatalogQueryNames], [
      "getPublicShellStatus",
      "getDashboardBundle",
      "listPublicPacks",
      "getPublicPack",
      "searchPublicCollectibles",
      "findPacksByDesiredCollectible",
    ]);
    assert.deepEqual(Object.keys(packCatalogV1QueryContracts), [...packCatalogQueryNames]);
    const defaultList = packCatalogV1QueryContracts.listPublicPacks.input.parse({});
    assert.deepEqual(defaultList.lifecycle, { retirements: ["active"], availabilities: ["available"] });
    const allState = packCatalogV1QueryContracts.listPublicPacks.input.parse({
      lifecycle: { retirements: ["retired", "active"], availabilities: ["unknown", "sold_out", "available", "unavailable"] },
    });
    assert.equal(allState.lifecycle.retirements.length, 2);
    assert.equal(allState.lifecycle.availabilities.length, 4);

    const headA = fixture.heads.packA;
    const packSummary = { ...headA.indexableSummary, publicPackSnapshotId: headA.activeSnapshot.publicPackSnapshotId, contentSha256: headA.activeSnapshot.contentSha256, headGeneration: headA.generation };
    const successCases = {
      getPublicShellStatus: { schemaVersion: PACK_CATALOG_V1, evaluatedAt: NOW, catalogAvailable: true, activeAvailablePackCount: 1 },
      getDashboardBundle: { evaluatedAt: NOW, packs: [packSummary], totalMatchingPacks: 1 },
      listPublicPacks: fixture.query.firstPage,
      getPublicPack: {
        evaluatedAt: NOW,
        snapshot: headA.activeSnapshot,
        summary: headA.indexableSummary,
        detail: {
          providerProfileSnapshotId: fixture.packs.packA.snapshot.payload.providerProfileSnapshotId,
          dataAsOf: fixture.packs.packA.snapshot.payload.dataAsOf,
          actions: fixture.packs.packA.snapshot.payload.actions,
          probabilityInputsSha256: fixture.packs.packA.snapshot.payload.probabilityInputsSha256,
          valuationDependencyIdentities: fixture.packs.packA.snapshot.payload.valuationDependencyIdentities,
          valuationsSha256: fixture.packs.packA.snapshot.payload.valuationsSha256,
          evMethodIdentity: fixture.packs.packA.snapshot.payload.evMethodIdentity,
          evPolicyIdentity: fixture.packs.packA.snapshot.payload.evPolicyIdentity,
          evInputsSha256: fixture.packs.packA.snapshot.payload.evInputsSha256,
          economicsSha256: fixture.packs.packA.snapshot.payload.economicsSha256,
          searchProjection: fixture.packs.packA.snapshot.payload.searchProjection,
        },
        contents: fixture.packs.packA.snapshot.payload.contents,
        contentCount: 2,
        nextContentsCursor: null,
      },
      searchPublicCollectibles: { evaluatedAt: NOW, items: [fixture.collectibles[0]!.profile], nextCursor: null },
      findPacksByDesiredCollectible: { evaluatedAt: NOW, publicCollectibleId: packCatalogFixtureIds.collectibleA, items: [packSummary], nextCursor: null },
    } as const;
    for (const name of packCatalogQueryNames) {
      packCatalogV1QueryContracts[name].output.parse({ ok: true, data: successCases[name] });
    }

    const cursor = await readPackCatalogCursor({ cursor: fixture.query.cursor, binding: fixture.query.binding, now: NOW, signingKey: SIGNING_KEY });
    assert.equal(cursor.lastStableId, packCatalogFixtureIds.packA);
    assert.equal("publicReleaseId" in cursor, false);
    assert.equal(fixture.query.firstPage.items[0]?.publicRepackId, packCatalogFixtureIds.packA);
    assert.equal(fixture.query.secondPage.items[0]?.publicRepackId, packCatalogFixtureIds.packB);

    await expectCursorExpired(() => readPackCatalogCursor({ cursor: fixture.query.cursor, binding: { ...fixture.query.binding, pageSize: 2 }, now: NOW, signingKey: SIGNING_KEY }));
    const replacement = fixture.query.cursor.endsWith("A") ? "B" : "A";
    await expectCursorExpired(() => readPackCatalogCursor({ cursor: fixture.query.cursor.slice(0, -1) + replacement, binding: fixture.query.binding, now: NOW, signingKey: SIGNING_KEY }));
    await expectCursorExpired(() => readPackCatalogCursor({ cursor: "bad", binding: fixture.query.binding, now: NOW, signingKey: SIGNING_KEY }));
    await expectCursorExpired(() => readPackCatalogCursor({ cursor: fixture.query.cursor, binding: fixture.query.binding, now: "2026-09-03T18:15:00.000Z", signingKey: SIGNING_KEY }));
  });

  await context.test("saved IDs and bounded errors expose no owner or snapshot identity", () => {
    assert.deepEqual([...savedCatalogErrorCodes], [
      "AUTH_REQUIRED",
      "AUTH_IDENTITY_INVALID",
      "INVALID_PUBLIC_REPACK_ID",
      "INVALID_PUBLIC_COLLECTIBLE_ID",
      "SAVED_RESOURCE_UNAVAILABLE",
      "SAVED_ITEM_LIMIT_REACHED",
      "SAVED_ITEMS_STATE_CONFLICT",
    ]);
    savedCatalogItemsV1Contract.getSavedItemIds.output.parse(fixture.saved);
    for (const saved of [true, true, false]) {
      savedCatalogItemsV1Contract.setSavedRepack.output.parse({ saved, prunedUnavailable: false });
    }
    for (const code of savedCatalogErrorCodes) {
      savedCatalogItemsV1Contract.setSavedCollectible.output.parse({ code, error: "Bounded saved-item outcome." });
    }
    assert.equal(savedCatalogItemsV1Contract.setSavedRepack.input.safeParse({ publicRepackId: packCatalogFixtureIds.packA, saved: true, ownerId: "client" }).success, false);
    assert.equal(savedCatalogItemsV1Contract.setSavedRepack.input.safeParse({ publicRepackId: packCatalogFixtureIds.packA, saved: true, publicPackSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId }).success, false);
    const ids = Array.from({ length: SAVED_CATALOG_ITEM_LIMIT }, (_, index) => `80000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    assert.equal(savedCatalogItemIdsSchema.safeParse({ savedRepackIds: ids, savedCollectibleIds: ids }).success, true);
    assert.equal(savedCatalogItemIdsSchema.safeParse({ savedRepackIds: [...ids, "80000000-0000-4000-8000-000000000250"], savedCollectibleIds: [] }).success, false);
    assert.equal(savedCatalogItemIdsSchema.safeParse({ savedRepackIds: [...ids].reverse(), savedCollectibleIds: [] }).success, false);
  });

  await context.test("permissions, service scope, replay, and state vocabularies fail closed", () => {
    assert.deepEqual([...publicationWorkStates], ["waiting", "ready", "publishing", "retry_scheduled", "blocked", "published", "superseded", "rolled_back"]);
    assert.equal(publicationWorkStates.includes("held" as never), false);
    assert.equal(publicationPlannerOutcomeSchema.parse("no_change"), "no_change");
    assert.deepEqual([...publicationOperationOutcomes], ["applied", "already_applied", "already_active", "conflict", "refused", "operation_expired"]);
    assert.deepEqual([...terminalPublicationWorkStates], ["published", "superseded", "rolled_back"]);
    assert.deepEqual([...alertablePublicationWorkStates], ["waiting", "ready", "publishing", "retry_scheduled"]);
    assert.equal(isTerminalPublicationWork("blocked", true), true);
    assert.equal(isTerminalPublicationWork("blocked", false), false);
    assert.equal(isPublicationAlertAgeEligible("waiting", false), true);
    assert.equal(isPublicationAlertAgeEligible("waiting", true), false);
    assert.deepEqual([...publicationReasonCodes], ["INCOMPLETE_CONTENTS", "INVALID_PROBABILITIES", "EV_INPUTS_PENDING", "EV_TECHNICAL_RETRY", "INVALID_DOMAIN_DATA", "PROFILE_HEAD_MISSING", "PROVIDER_UNREACHABLE", "TRANSPORT_TIMEOUT", "RECEIPT_AMBIGUOUS", "LEASE_LOST", "ACTIVATION_CONFLICT", "OPERATOR_HOLD", "AUTHORIZATION_REFUSED", "OPERATION_EXPIRED"]);
    assert.equal(publicationReasonDefaultState.EV_TECHNICAL_RETRY, "retry_scheduled");
    assert.equal(publicationReasonDefaultState.INVALID_DOMAIN_DATA, "blocked");
    assert.deepEqual([...packCatalogReadErrorCodes], ["INVALID_QUERY", "CURSOR_EXPIRED", "CATALOG_UNAVAILABLE", "PACK_NOT_FOUND", "COLLECTIBLE_NOT_FOUND", "AUTH_REQUIRED", "UNAUTHORIZED"]);
    for (const permission of packCatalogAdminPermissions) {
      assert.ok(permissionsForOperatorRole("admin").includes(permission));
      assert.equal(permissionsForOperatorRole("data_operator").includes(permission), false);
    }
    assert.ok(permissionsForOperatorRole("data_operator").includes("providers:view"));
    const viewer = { operatorId: "90000000-0000-4000-8000-000000000001", organizationId: packCatalogFixtureIds.organizationId, state: "active", role: "data_operator", permission: "providers:view" };
    const response = { organizationId: packCatalogFixtureIds.organizationId, statuses: [], evaluatedAt: NOW };
    assert.equal(canReadPackPublicationStatus(viewer, response), true);
    assert.equal(canReadPackPublicationStatus(viewer, { ...response, organizationId: "10000000-0000-4000-8000-000000000002" }), false);

    const serviceIdentity = {
      serviceIdentityId: "90000000-0000-4000-8000-000000000002",
      environment: "live",
      organizationId: packCatalogFixtureIds.organizationId,
      scope: { scopeKind: "provider", providerId: packCatalogFixtureIds.providerId },
      entity: { entityKind: "pack", publicRepackId: packCatalogFixtureIds.packA },
      operations: ["activate_head"],
      issuedAt: "2026-09-03T18:00:00.000Z",
      expiresAt: "2026-09-03T18:20:00.000Z",
      authorizationSha256: SHA_A,
    } as const;
    const access = { identity: serviceIdentity, environment: "live" as const, organizationId: packCatalogFixtureIds.organizationId, providerId: packCatalogFixtureIds.providerId, entity: serviceIdentity.entity, operation: "activate_head" as const, now: NOW };
    assert.equal(trustedPackCatalogServiceIdentityAllows(access), true);
    assert.equal(trustedPackCatalogServiceIdentityAllows({ ...access, environment: "preproduction" }), false);
    assert.equal(trustedPackCatalogServiceIdentityAllows({ ...access, organizationId: "10000000-0000-4000-8000-000000000002" }), false);
    assert.equal(trustedPackCatalogServiceIdentityAllows({ ...access, providerId: "20000000-0000-4000-8000-000000000002" }), false);
    assert.equal(trustedPackCatalogServiceIdentityAllows({ ...access, entity: { entityKind: "pack", publicRepackId: packCatalogFixtureIds.packB } }), false);
    assert.equal(trustedPackCatalogServiceIdentityAllows({ ...access, operation: "read_receipt" }), false);
    assert.equal(trustedPackCatalogServiceIdentityAllows({ ...access, now: "2026-09-03T18:20:00.000Z" }), false);

    const replay = publicationReplayRecordSchema.parse({ operationId: "90000000-0000-4000-8000-000000000004", idempotencyKey: "activate:1", authorizationScopeSha256: SHA_B, entityIdentity: `pack:${packCatalogFixtureIds.packA}`, snapshotIdentity: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, requestSha256: SHA_A, state: "published", completedAt: "2026-09-03T18:00:00.000Z", expiresAt: "2026-10-03T18:00:00.000Z" });
    assert.equal(evaluatePublicationReplay({ record: replay, requestSha256: SHA_A, now: NOW }).outcome, "already_applied");
    assert.equal(evaluatePublicationReplay({ record: replay, requestSha256: SHA_B, now: NOW }).outcome, "conflict");
    assert.equal(evaluatePublicationReplay({ record: replay, requestSha256: SHA_A, now: replay.expiresAt }).outcome, "operation_expired");

    const recovery = { operationId: "90000000-0000-4000-8000-000000000003", channel: "out_of_band", idempotencyKey: "recover:1", requestSha256: SHA_A, expiresAt: "2026-09-03T18:20:00.000Z", authorization: { operatorId: viewer.operatorId, organizationId: viewer.organizationId, state: "active", role: "admin", permission: "pack_publication:recover", authorizedAt: NOW }, providerId: packCatalogFixtureIds.providerId, publicRepackId: packCatalogFixtureIds.packA, action: "retry", targetSnapshotId: null };
    assert.equal(packRecoveryOperationSchema.safeParse(recovery).success, true);
    assert.equal(packRecoveryOperationSchema.safeParse({ ...recovery, channel: "admin" }).success, false);
    assert.equal(packRecoveryOperationSchema.safeParse({ ...recovery, authorization: { ...recovery.authorization, role: "data_operator" } }).success, false);
  });

  await context.test("P01 freezes bounded contract limits and excludes Heat", () => {
    assert.equal(PACK_SNAPSHOT_BATCH_MAX_ITEMS, 250);
    assert.equal(PACK_SNAPSHOT_BATCH_MAX_BYTES, 480_000);
    assert.equal(PACK_SNAPSHOT_MAX_CONTENTS, 8_000);
    assert.equal(PACK_CATALOG_LIST_MAX_ITEMS, 50);
    assert.equal(PACK_CONTENT_PAGE_MAX_ITEMS, 100);
    assert.equal(PACK_CATALOG_CURSOR_LIFETIME_MS, 15 * 60 * 1_000);
    assert.equal(PACK_PUBLICATION_REPLAY_LIFETIME_MS, 30 * 24 * 60 * 60 * 1_000);
    assert.equal(JSON.stringify(fixture).toLocaleLowerCase("en-US").includes("heat"), false);
  });
});
