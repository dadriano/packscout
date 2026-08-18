/// <reference types="vite/client" />

import {
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  PRODUCTION_REPACK_HEAT_PATHS,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  productionHeatSignedReceiptEnvelopeSchema,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  signedProviderInit,
  verifyProviderResponseSignature,
} from "./providerReleaseSecurity.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SERVER_TIME = "2026-08-16T12:00:00.000Z";
const HEAT_KEY_ID = "heat-publisher-v1";
const PROVIDER_KEY_ID = "provider-alpha-v1";
const MANIFEST_CLEAR_KEY_ID = "manifest-clear-v1";
const MANIFEST_PUBLISH_KEY_ID = "manifest-publish-v1";
const MANIFEST_RETAIN_KEY_ID = "manifest-retain-v1";
const SECRET_BY_KEY_ID = Object.freeze({
  [HEAT_KEY_ID]: "packscout-heat-auth-secret-000000000000000001",
  [PROVIDER_KEY_ID]: "packscout-provider-auth-secret-000000000000001",
  [MANIFEST_CLEAR_KEY_ID]: "packscout-clear-auth-secret-0000000000000001",
  [MANIFEST_PUBLISH_KEY_ID]: "packscout-publish-auth-secret-000000000000001",
  [MANIFEST_RETAIN_KEY_ID]: "packscout-retain-auth-secret-0000000000000001",
});

type PublicationKeyId = keyof typeof SECRET_BY_KEY_ID;

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configureDedicatedHeatAuthority(): void {
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
    "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
    canonicalJson([HEAT_KEY_ID]),
  );
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    canonicalJson({ [PROVIDER_KEY_ID]: "alpha" }),
  );
  vi.stubEnv(
    "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
    canonicalJson({
      [MANIFEST_CLEAR_KEY_ID]: ["clear"],
      [MANIFEST_PUBLISH_KEY_ID]: ["publish"],
      [MANIFEST_RETAIN_KEY_ID]: ["retain"],
    }),
  );
}

async function storedHeatSecurityState(
  t: ReturnType<typeof createTest>,
) {
  return await t.run(async (ctx) => ({
    nonces: (await ctx.db.query("dataReleaseAuthNonces").collect()).map(
      ({ keyId, requestDigest }) => ({ keyId, requestDigest }),
    ),
    states: (await ctx.db.query("repackHeatState").collect()).length,
    snapshots: (await ctx.db.query("repackHeatSnapshots").collect()).length,
    signalSets: (await ctx.db.query("repackHeatSignalSets").collect()).length,
    signals: (await ctx.db.query("repackHeatSignals").collect()).length,
    publications:
      (await ctx.db.query("repackHeatPublications").collect()).length,
    batches: (await ctx.db.query("repackHeatBatches").collect()).length,
    operations: (await ctx.db.query("repackHeatOperations").collect()).length,
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("production Heat HTTP key authority", () => {
  test("accepts the Heat key and refuses every wrong-role key on every Heat route without writes or read leakage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    configureDedicatedHeatAuthority();
    const t = createTest();
    const activeStateResponse = await t.fetch(
      PRODUCTION_REPACK_HEAT_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_REPACK_HEAT_PATHS.activeState,
        {
          schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
          operationId: "heat:security:active-state",
        },
        {
          keyId: HEAT_KEY_ID,
          secret: SECRET_BY_KEY_ID[HEAT_KEY_ID],
          nonce: "heatSecuritySuccess0001",
        },
      ),
    );
    expect(activeStateResponse.status).toBe(200);
    const activeStateEnvelope = productionHeatSignedReceiptEnvelopeSchema.parse(
      await activeStateResponse.json(),
    );
    expect(activeStateEnvelope).toMatchObject({
      receipt: {
        operationKind: "activeState",
        publicationId: null,
        details: {
          activePublicHeatFrameId: null,
          manifestAlignment: null,
          terminalReceiptSha256: null,
        },
      },
      responseAuth: { keyId: HEAT_KEY_ID },
    });
    expect(await verifyProviderResponseSignature(
      activeStateEnvelope,
      SECRET_BY_KEY_ID[HEAT_KEY_ID],
    )).toBe(true);
    const stateAfterAuthorizedRead = await storedHeatSecurityState(t);

    const wrongRoleKeyIds = [
      PROVIDER_KEY_ID,
      MANIFEST_CLEAR_KEY_ID,
      MANIFEST_PUBLISH_KEY_ID,
      MANIFEST_RETAIN_KEY_ID,
    ] as const;
    let requestSequence = 0;
    for (const path of Object.values(PRODUCTION_REPACK_HEAT_PATHS)) {
      for (const keyId of wrongRoleKeyIds) {
        requestSequence += 1;
        const response = await t.fetch(
          path,
          await signedProviderInit(path, {}, {
            keyId,
            secret: SECRET_BY_KEY_ID[keyId],
            nonce: `heatWrongRole${String(requestSequence).padStart(8, "0")}`,
          }),
        );
        expect(response.status, `${path} accepted ${keyId}`).toBe(401);
        expect(await response.json()).toEqual({
          error: "The publication signing key is not accepted.",
          code: "PUBLICATION_AUTH_KEY_UNKNOWN",
        });
      }
    }

    expect(await storedHeatSecurityState(t)).toEqual(stateAfterAuthorizedRead);
  });

  test.each([
    ["provider", "provider"],
    ["manifest clear", "clear"],
    ["manifest publish", "publish"],
    ["manifest retain", "retain"],
    ["manifest rollback", "rollback"],
  ] as const)(
    "fails closed when the Heat key overlaps %s authority",
    async (_label, authority) => {
      vi.useFakeTimers();
      vi.setSystemTime(SERVER_TIME);
      vi.stubEnv(
        "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
        canonicalJson({
          [HEAT_KEY_ID]: btoa(SECRET_BY_KEY_ID[HEAT_KEY_ID]),
        }),
      );
      vi.stubEnv(
        "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
        canonicalJson([HEAT_KEY_ID]),
      );
      if (authority === "provider") {
        vi.stubEnv(
          "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
          canonicalJson({ [HEAT_KEY_ID]: "alpha" }),
        );
      } else {
        vi.stubEnv(
          "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
          canonicalJson({ [HEAT_KEY_ID]: [authority] }),
        );
      }
      const t = createTest();
      const response = await t.fetch(
        PRODUCTION_REPACK_HEAT_PATHS.activeState,
        await signedProviderInit(
          PRODUCTION_REPACK_HEAT_PATHS.activeState,
          {
            schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
            operationId: `heat:security:overlap:${authority}`,
          },
          {
            keyId: HEAT_KEY_ID,
            secret: SECRET_BY_KEY_ID[HEAT_KEY_ID],
            nonce: `heatOverlap${authority}00000001`,
          },
        ),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "The publication signing key is not accepted.",
        code: "PUBLICATION_AUTH_KEY_UNKNOWN",
      });
      expect(await storedHeatSecurityState(t)).toEqual({
        nonces: [],
        states: 0,
        snapshots: 0,
        signalSets: 0,
        signals: 0,
        publications: 0,
        batches: 0,
        operations: 0,
      });
    },
  );

  test("fails every publication surface closed before nonce consumption when distinct role IDs share secret bytes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const sharedSecret = "packscout-cross-role-shared-secret-0000000001";
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
      canonicalJson({
        [HEAT_KEY_ID]: btoa(sharedSecret),
        [MANIFEST_PUBLISH_KEY_ID]: btoa(sharedSecret),
        [PROVIDER_KEY_ID]: btoa(sharedSecret),
      }),
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
    const t = createTest();
    const requests = [
      {
        path: PRODUCTION_REPACK_HEAT_PATHS.activeState,
        keyId: HEAT_KEY_ID,
        code: "PUBLICATION_AUTH_KEY_UNKNOWN",
      },
      {
        path: PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
        keyId: PROVIDER_KEY_ID,
        code: "PROVIDER_RELEASE_AUTH_KEY_UNKNOWN",
      },
      {
        path: PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
        keyId: MANIFEST_PUBLISH_KEY_ID,
        code: "CATALOG_MANIFEST_AUTH_KEY_UNKNOWN",
      },
    ] as const;

    for (const [index, request] of requests.entries()) {
      const response = await t.fetch(
        request.path,
        await signedProviderInit(request.path, {}, {
          keyId: request.keyId,
          secret: sharedSecret,
          nonce: `sharedSecretRole${String(index).padStart(8, "0")}`,
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: request.code });
    }

    expect(await storedHeatSecurityState(t)).toEqual({
      nonces: [],
      states: 0,
      snapshots: 0,
      signalSets: 0,
      signals: 0,
      publications: 0,
      batches: 0,
      operations: 0,
    });
  });

  test("refuses an authorized Heat ID when an unbound configured ID shares its secret", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    const orphanKeyId = "orphan-publication-v1";
    const sharedSecret = "packscout-orphan-shared-secret-00000000000001";
    vi.stubEnv(
      "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
      canonicalJson({
        [HEAT_KEY_ID]: btoa(sharedSecret),
        [orphanKeyId]: btoa(sharedSecret),
      }),
    );
    vi.stubEnv(
      "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS",
      canonicalJson([HEAT_KEY_ID]),
    );
    const t = createTest();
    const response = await t.fetch(
      PRODUCTION_REPACK_HEAT_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_REPACK_HEAT_PATHS.activeState,
        {
          schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
          operationId: "heat:security:orphan-shared-secret",
        },
        {
          keyId: HEAT_KEY_ID,
          secret: sharedSecret,
          nonce: "heatOrphanShared000001",
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "PUBLICATION_AUTH_KEY_UNKNOWN",
    });
    expect((await storedHeatSecurityState(t)).nonces).toEqual([]);
  });
});
