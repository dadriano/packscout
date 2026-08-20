/// <reference types="vite/client" />

import {
  MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES,
  PRODUCTION_DATA_RELEASE_V3_PATHS,
  PRODUCTION_REPACK_HEAT_PATHS,
  canonicalJson,
  productionReceiptHash,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import { DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN } from "./dataReleaseV3Lifecycle";
import {
  buildV3Detail,
  buildV3FixturePlan,
  v3ActivateRequest,
  v3BatchRequest,
  v3FinalizeRequest,
  v3StartRequest,
  V3_REPACK_ID_A,
  type V3FixturePlan,
} from "./dataReleaseV3Fixture.test-support";
import {
  providerBodyDigest,
  signedProviderInit,
  verifyProviderResponseSignature,
} from "./providerReleaseSecurity.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const V3_KEY_ID = "data-release-v3-publisher.v1";
const V3_SECRET = "packscout-v3-publisher-auth-secret-000000001";
const HEAT_KEY_ID = "heat-publisher-v1";
const PROVIDER_KEY_ID = "provider-alpha-v1";
const MANIFEST_PUBLISH_KEY_ID = "manifest-publish-v1";
const SECRET_BY_KEY_ID = Object.freeze({
  [V3_KEY_ID]: V3_SECRET,
  [HEAT_KEY_ID]: "packscout-heat-auth-secret-000000000000000001",
  [PROVIDER_KEY_ID]: "packscout-provider-auth-secret-000000000000001",
  [MANIFEST_PUBLISH_KEY_ID]: "packscout-publish-auth-secret-000000000000001",
});

const RELEASE_ID = "10000000-0000-4000-8000-0000000000a1";
const UNKNOWN_RELEASE_ID = "10000000-0000-4000-8000-0000000000ff";

type V3Test = TestConvex<typeof schema>;

function createTest(): V3Test {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configureDedicatedV3Authority(): void {
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    canonicalJson(Object.fromEntries(
      Object.entries(SECRET_BY_KEY_ID).map(([keyId, secret]) => [
        keyId,
        btoa(secret),
      ]),
    )),
  );
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
    canonicalJson([V3_KEY_ID]),
  );
  vi.stubEnv(
    "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
    canonicalJson([HEAT_KEY_ID]),
  );
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    canonicalJson({ [PROVIDER_KEY_ID]: "alpha" }),
  );
  vi.stubEnv(
    "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
    canonicalJson({ [MANIFEST_PUBLISH_KEY_ID]: ["publish"] }),
  );
}

let nonceSequence = 0;
function nextNonce(label: string): string {
  nonceSequence += 1;
  return `v3${label}${String(nonceSequence).padStart(14, "0")}`;
}

async function postV3(
  t: V3Test,
  path: string,
  body: unknown,
  overrides: Readonly<{
    bodyJson?: string;
    keyId?: string;
    secret?: string;
    signature?: string;
    timestamp?: string;
    nonce?: string;
  }> = {},
): Promise<{ response: Response; bodyJson: string }> {
  const bodyJson = overrides.bodyJson ?? canonicalJson(body);
  const response = await t.fetch(path, await signedProviderInit(path, body, {
    bodyJson,
    keyId: overrides.keyId ?? V3_KEY_ID,
    secret: overrides.secret ?? SECRET_BY_KEY_ID[V3_KEY_ID],
    signature: overrides.signature,
    timestamp: overrides.timestamp,
    nonce: overrides.nonce ?? nextNonce("Nonce"),
  }));
  return { response, bodyJson };
}

async function expectSignedV3Receipt(
  result: { response: Response; bodyJson: string },
): Promise<Record<string, unknown>> {
  expect(result.response.status).toBe(200);
  const envelope = (await result.response.json()) as {
    ok: boolean;
    receipt: Record<string, unknown>;
    responseAuth: {
      signatureVersion: string;
      keyId: string;
      receiptDigest: string;
      signature: string;
    };
  };
  expect(envelope.ok).toBe(true);
  expect(envelope.responseAuth.keyId).toBe(V3_KEY_ID);
  expect(
    await verifyProviderResponseSignature(envelope, SECRET_BY_KEY_ID[V3_KEY_ID]),
  ).toBe(true);
  expect(envelope.responseAuth.receiptDigest).toBe(
    await productionReceiptHash(envelope.receipt),
  );
  const { receiptDigest, ...receiptBody } = envelope.receipt;
  expect(receiptDigest).toBe(
    await sha256CanonicalJson(DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN, receiptBody),
  );
  expect(envelope.receipt.requestDigest).toBe(
    await providerBodyDigest(result.bodyJson),
  );
  return envelope.receipt;
}

async function storedV3SecurityState(t: V3Test) {
  return await t.run(async (ctx) => ({
    nonces: (await ctx.db.query("dataReleaseAuthNonces").collect()).length,
    releases: (await ctx.db.query("dataReleaseV3Releases").collect()).length,
    operations: (await ctx.db.query("dataReleaseV3Operations").collect()).length,
  }));
}

async function buildSecurityPlan(): Promise<V3FixturePlan> {
  return await buildV3FixturePlan({
    publicReleaseId: RELEASE_ID,
    details: [buildV3Detail({ publicRepackId: V3_REPACK_ID_A })],
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("data_release_v3 HTTP transport", () => {
  test("publishes, reads back, activates, replays, and refuses conflicts over signed HTTP", async () => {
    configureDedicatedV3Authority();
    const t = createTest();
    const plan = await buildSecurityPlan();

    const genesis = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      { schemaVersion: "data_release_v3", operationId: "v3-security-active" },
    ));
    expect(genesis).toMatchObject({
      operationKind: "activeState",
      result: "active_state",
      publicReleaseId: null,
      details: { generation: 0, activeRelease: null, previousRelease: null },
    });

    const startReceipt = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.start,
      v3StartRequest(plan),
    ));
    expect(startReceipt).toMatchObject({
      operationKind: "start",
      result: "started",
      publicReleaseId: RELEASE_ID,
    });
    for (const batch of plan.batches) {
      const receipt = await expectSignedV3Receipt(await postV3(
        t,
        PRODUCTION_DATA_RELEASE_V3_PATHS.applyBatch,
        v3BatchRequest(plan, batch),
      ));
      expect(receipt).toMatchObject({
        operationKind: "applyBatch",
        result: "accepted",
      });
    }
    const finalizeReceipt = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.finalize,
      v3FinalizeRequest(plan),
    ));
    expect(finalizeReceipt).toMatchObject({
      operationKind: "finalize",
      result: "complete",
    });

    const statusReceipt = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.status,
      {
        schemaVersion: "data_release_v3",
        operationId: `v3-security-status:${RELEASE_ID}`,
        publicReleaseId: RELEASE_ID,
      },
    ));
    expect(statusReceipt).toMatchObject({
      operationKind: "status",
      result: "status",
      publicReleaseId: RELEASE_ID,
      details: {
        status: {
          publicReleaseId: RELEASE_ID,
          releaseFingerprint: plan.releaseFingerprint,
          lifecycle: "complete",
          acceptedBatchCount: plan.manifest.batchCount,
          acceptedBatchChainHash: plan.manifest.batchChainHash,
        },
      },
    });

    const activateReceipt = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activate,
      v3ActivateRequest(plan, null),
    ));
    expect(activateReceipt).toMatchObject({
      operationKind: "activate",
      result: "activated",
    });
    const activeState = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      { schemaVersion: "data_release_v3", operationId: "v3-security-active-2" },
    ));
    expect(activeState).toMatchObject({
      publicReleaseId: RELEASE_ID,
      details: {
        generation: 1,
        activeRelease: {
          publicReleaseId: RELEASE_ID,
          releaseFingerprint: plan.releaseFingerprint,
        },
        previousRelease: null,
      },
    });

    const notFound = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.status,
      {
        schemaVersion: "data_release_v3",
        operationId: `v3-security-status:${UNKNOWN_RELEASE_ID}`,
        publicReleaseId: UNKNOWN_RELEASE_ID,
      },
    ));
    expect(notFound).toMatchObject({
      result: "not_found",
      publicReleaseId: UNKNOWN_RELEASE_ID,
      details: {},
    });

    // A byte-identical replay converges on the stored receipt.
    const replay = await expectSignedV3Receipt(await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.applyBatch,
      v3BatchRequest(plan, plan.batches[0]!),
    ));
    expect(replay).toMatchObject({
      operationKind: "applyBatch",
      result: "accepted",
      details: { batchIndex: 0 },
    });

    // A conflicting replay of a stored operation id passes through as 409.
    const conflict = await postV3(t, PRODUCTION_DATA_RELEASE_V3_PATHS.finalize, {
      ...v3FinalizeRequest(plan),
      expectedTopChaseCount: plan.manifest.topChaseCount + 1,
    });
    expect(conflict.response.status).toBe(409);
    expect(await conflict.response.json()).toEqual({
      error: "The publication operation identity conflicts with stored state.",
      code: "PUBLICATION_OPERATION_CONFLICT",
    });
  });

  test("accepts only the v3 key and refuses every wrong-role key on every v3 route without writes", async () => {
    configureDedicatedV3Authority();
    const t = createTest();
    const baseline = await storedV3SecurityState(t);

    const wrongRoleKeyIds = [
      HEAT_KEY_ID,
      PROVIDER_KEY_ID,
      MANIFEST_PUBLISH_KEY_ID,
    ] as const;
    for (const path of Object.values(PRODUCTION_DATA_RELEASE_V3_PATHS)) {
      for (const keyId of wrongRoleKeyIds) {
        const { response } = await postV3(t, path, {}, {
          keyId,
          secret: SECRET_BY_KEY_ID[keyId],
        });
        expect(response.status, `${path} accepted ${keyId}`).toBe(401);
        expect(await response.json()).toEqual({
          error: "The publication signing key is not accepted.",
          code: "PUBLICATION_AUTH_KEY_UNKNOWN",
        });
      }
    }
    // The v3 key holds no other authority.
    const heatResponse = await postV3(
      t,
      PRODUCTION_REPACK_HEAT_PATHS.activeState,
      { schemaVersion: "repack_heat_v1", operationId: "v3-key-on-heat" },
    );
    expect(heatResponse.response.status).toBe(401);
    expect(await heatResponse.response.json()).toMatchObject({
      code: "PUBLICATION_AUTH_KEY_UNKNOWN",
    });
    expect(await storedV3SecurityState(t)).toEqual(baseline);
  });

  test("fails closed before nonce consumption when the v3 key overlaps another authority or shares secret bytes", async () => {
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
      canonicalJson({ [V3_KEY_ID]: btoa(V3_SECRET) }),
    );
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
      canonicalJson([V3_KEY_ID]),
    );
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([V3_KEY_ID]),
    );
    const overlapping = createTest();
    const overlapResponse = await postV3(
      overlapping,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      { schemaVersion: "data_release_v3", operationId: "v3-overlap" },
    );
    expect(overlapResponse.response.status).toBe(401);
    expect(await overlapResponse.response.json()).toMatchObject({
      code: "PUBLICATION_AUTH_KEY_UNKNOWN",
    });
    expect(await storedV3SecurityState(overlapping)).toEqual({
      nonces: 0,
      releases: 0,
      operations: 0,
    });

    vi.unstubAllEnvs();
    const orphanKeyId = "orphan-publication-v1";
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
      canonicalJson({
        [V3_KEY_ID]: btoa(V3_SECRET),
        [orphanKeyId]: btoa(V3_SECRET),
      }),
    );
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
      canonicalJson([V3_KEY_ID]),
    );
    const sharedSecret = createTest();
    const sharedResponse = await postV3(
      sharedSecret,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      { schemaVersion: "data_release_v3", operationId: "v3-shared-secret" },
    );
    expect(sharedResponse.response.status).toBe(401);
    expect(await sharedResponse.response.json()).toMatchObject({
      code: "PUBLICATION_AUTH_KEY_UNKNOWN",
    });
    expect((await storedV3SecurityState(sharedSecret)).nonces).toBe(0);
  });

  test("refuses tampered digests, forged signatures, stale timestamps, replayed nonces, and cross-path signatures", async () => {
    configureDedicatedV3Authority();
    const t = createTest();
    const body = {
      schemaVersion: "data_release_v3",
      operationId: "v3-auth-probe",
    };

    // Declared content digest does not match the delivered bytes.
    const tamperedInit = await signedProviderInit(
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      body,
      {
        keyId: V3_KEY_ID,
        secret: V3_SECRET,
        nonce: nextNonce("Tamper"),
      },
    );
    tamperedInit.body = canonicalJson({ ...body, operationId: "v3-tampered" });
    const tampered = await t.fetch(
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      tamperedInit,
    );
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toMatchObject({
      code: "PUBLICATION_AUTH_INVALID",
    });

    const forged = await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      body,
      { signature: "f".repeat(64) },
    );
    expect(forged.response.status).toBe(401);
    expect(await forged.response.json()).toMatchObject({
      code: "PUBLICATION_AUTH_INVALID",
    });

    const stale = await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      body,
      { timestamp: String(Date.now() - 6 * 60_000) },
    );
    expect(stale.response.status).toBe(401);
    expect(await stale.response.json()).toMatchObject({
      code: "PUBLICATION_AUTH_STALE",
    });

    // A signature minted for one v3 path cannot authorize another.
    const crossPathInit = await signedProviderInit(
      PRODUCTION_DATA_RELEASE_V3_PATHS.start,
      body,
      {
        keyId: V3_KEY_ID,
        secret: V3_SECRET,
        nonce: nextNonce("CrossPath"),
      },
    );
    const crossPath = await t.fetch(
      PRODUCTION_DATA_RELEASE_V3_PATHS.finalize,
      crossPathInit,
    );
    expect(crossPath.status).toBe(401);
    expect(await crossPath.json()).toMatchObject({
      code: "PUBLICATION_AUTH_INVALID",
    });
    expect((await storedV3SecurityState(t)).nonces).toBe(0);

    const replayNonce = nextNonce("Replay");
    const first = await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      body,
      { nonce: replayNonce },
    );
    expect(first.response.status).toBe(200);
    const replayed = await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      body,
      { nonce: replayNonce },
    );
    expect(replayed.response.status).toBe(401);
    expect(await replayed.response.json()).toMatchObject({
      code: "PUBLICATION_AUTH_REPLAYED",
    });
  });

  test("applies the v3 body limit: above the legacy cap is accepted, above the v3 cap fails closed", async () => {
    configureDedicatedV3Authority();
    const t = createTest();

    // 200 KiB exceeds the legacy 128 KiB cap but is within the v3 cap, so it
    // reaches request validation instead of the byte refusal.
    const midSized = canonicalJson({
      schemaVersion: "data_release_v3",
      operationId: "v3-mid-sized-body",
      pad: "x".repeat(200 * 1_024),
    });
    const midResponse = await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      null,
      { bodyJson: midSized },
    );
    expect(midResponse.response.status).toBe(400);
    expect(await midResponse.response.json()).toMatchObject({
      code: "PUBLICATION_REQUEST_INVALID",
    });

    const oversized = canonicalJson({
      schemaVersion: "data_release_v3",
      operationId: "v3-oversized-body",
      pad: "x".repeat(MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES),
    });
    const oversizedResponse = await postV3(
      t,
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      null,
      { bodyJson: oversized },
    );
    expect(oversizedResponse.response.status).toBe(413);
    expect(await oversizedResponse.response.json()).toMatchObject({
      code: "PUBLICATION_BODY_TOO_LARGE",
    });
    // The oversized request was refused before its nonce was consumed.
    const state = await storedV3SecurityState(t);
    expect(state.releases).toBe(0);
    expect(state.operations).toBe(0);
    expect(state.nonces).toBe(1);
  });
});
