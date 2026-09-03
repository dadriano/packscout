import assert from "node:assert/strict";
import test from "node:test";
import type { CentralPrismaClient } from "@packscout/database";
import type {
  SignedConvexCatalogManifestPublicationClient,
  VerifiedManifestGateProofSource,
} from "@packscout/services";
import { ManifestReconciliationOneShot } from
  "./manifest-reconciliation-one-shot.ts";
import { createManifestReconciliationOneShot } from
  "./manifest-reconciliation-worker-composition.ts";

test("central composition wires the ledger, fair gate queue, signed transport, and proof seam", () => {
  const proofs: VerifiedManifestGateProofSource = {
    async resolveTarget() {
      return {
        state: "blocked",
        failureCode: "PROVIDER_MANIFEST_GATE_TEST_ONLY",
      };
    },
    async resolveSignedState() {
      return {
        state: "blocked",
        failureCode: "PROVIDER_MANIFEST_GATE_TEST_ONLY",
      };
    },
  };
  const runner = createManifestReconciliationOneShot({
    central: {} as CentralPrismaClient,
    workerId: "manifest-reconciliation:test",
    currentManifestClient: {} as SignedConvexCatalogManifestPublicationClient,
    historicalManifestStatusClients: [],
    proofs,
    now: () => new Date("2026-09-01T20:00:00.000Z"),
  });
  assert.ok(runner instanceof ManifestReconciliationOneShot);
});
