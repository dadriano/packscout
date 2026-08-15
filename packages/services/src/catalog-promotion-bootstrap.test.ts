import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CatalogPromotionBootstrapCoordinator,
  type CatalogPromotionBootstrapState,
} from "./catalog-promotion-bootstrap.ts";

const verifiedAt = new Date("2026-08-15T12:00:00.000Z");
const publicationId = "50000000-0000-4000-8000-000000000001";

test("bootstrap verifies an empty deployment before the first claim", async () => {
  const verified: unknown[] = [];
  const coordinator = new CatalogPromotionBootstrapCoordinator({
    async loadBootstrapState() { return "unverified"; },
    async verifyBootstrap(input) { verified.push(input); },
  }, {
    async activeState() {
      return {
        activePublicReleaseId: null,
        observationSequence: 0,
        terminalReceiptSha256: null,
      };
    },
  });
  await coordinator.ensureVerified({
    organizationId: "10000000-0000-4000-8000-000000000001",
    deploymentKey: "production-us",
    lane: "catalog",
    verifiedAt,
  });
  assert.deepEqual(verified, [{
    laneKey: "catalog",
    observedPublicationIdentity: null,
    observedWatermark: 0n,
    observedReceiptSha256: null,
    verifiedAt,
  }]);
});

test("bootstrap proves a nonempty pointer and skips already verified lanes", async () => {
  let state: CatalogPromotionBootstrapState = "unverified";
  let remoteReads = 0;
  const verified: unknown[] = [];
  const coordinator = new CatalogPromotionBootstrapCoordinator({
    async loadBootstrapState() { return state; },
    async verifyBootstrap(input) {
      verified.push(input);
      state = "verified_local";
    },
  }, {
    async activeState() {
      remoteReads += 1;
      return {
        activePublicReleaseId: publicationId,
        observationSequence: 42,
        terminalReceiptSha256: "a".repeat(64),
      };
    },
  });
  const input = {
    organizationId: "10000000-0000-4000-8000-000000000001",
    deploymentKey: "production-us",
    lane: "catalog" as const,
    verifiedAt,
  };
  await coordinator.ensureVerified(input);
  await coordinator.ensureVerified(input);
  assert.equal(remoteReads, 1);
  assert.deepEqual(verified, [{
    laneKey: "catalog",
    observedPublicationIdentity: publicationId,
    observedWatermark: 42n,
    observedReceiptSha256: "a".repeat(64),
    verifiedAt,
  }]);
});
