import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProviderSourceRequestSchema,
  createSourceConnectionProfileRequestSchema,
  productionProviderSourceTypeKeys,
  providerSourceAdminAuditReceiptSchema,
  providerSourceAdminCatalogSchema,
  providerSourceCursorResetPreviewSchema,
} from "./provider-source-admin.ts";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  provider: "00000000-0000-4000-8000-000000000002",
  profile: "00000000-0000-4000-8000-000000000003",
  revision: "00000000-0000-4000-8000-000000000004",
  source: "00000000-0000-4000-8000-000000000005",
  sourceRevision: "00000000-0000-4000-8000-000000000006",
  scheduleRevision: "00000000-0000-4000-8000-000000000007",
} as const;

test("production source configuration exposes exactly one compiled source type", () => {
  assert.deepEqual(productionProviderSourceTypeKeys, ["dataforrest-events-v1"]);
  assert.equal(
    createProviderSourceRequestSchema.safeParse({
      providerId: ids.provider,
      connectionProfileId: ids.profile,
      sourceTypeKey: "alternate-bookmark-v1",
      mapperKey: "courtyard-provider-observation",
      mapperVersion: "1",
      intervalSeconds: 60,
    }).success,
    false,
  );
});

test("connection credential input is strict while every catalog response is masked", () => {
  const secret = "credential-that-must-never-return";
  assert.equal(
    createSourceConnectionProfileRequestSchema.safeParse({
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Shared DataForrest",
      endpoint: "https://dataforrest.example/v1/events",
      bearerCredential: secret,
      requestLimit: 2,
    }).success,
    true,
  );
  assert.equal(
    createSourceConnectionProfileRequestSchema.safeParse({
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Shared DataForrest",
      endpoint: "https://dataforrest.example/v1/events",
      bearerCredential: secret,
      requestLimit: 2,
      credentialEcho: secret,
    }).success,
    false,
  );
  for (const invalidCredential of [` ${secret}`, `${secret} `, `bad\0secret`]) {
    assert.equal(
      createSourceConnectionProfileRequestSchema.safeParse({
        sourceTypeKey: "dataforrest-events-v1",
        displayName: "Shared DataForrest",
        endpoint: "https://dataforrest.example/v1/events",
        bearerCredential: invalidCredential,
        requestLimit: 2,
      }).success,
      false,
    );
  }
  for (const invalidRequestLimit of [1, 3, 4]) {
    assert.equal(
      createSourceConnectionProfileRequestSchema.safeParse({
        sourceTypeKey: "dataforrest-events-v1",
        displayName: "Shared DataForrest",
        endpoint: "https://dataforrest.example/v1/events",
        bearerCredential: secret,
        requestLimit: invalidRequestLimit,
      }).success,
      false,
    );
  }

  const catalog = providerSourceAdminCatalogSchema.parse({
    availableSourceTypes: [{
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      label: "DataForrest events",
    }],
    providers: [{
      id: ids.provider,
      provider: "courtyard",
      sourceRegistration: {
        sourceTypeKey: "dataforrest-events-v1",
        sourceAdapterVersion: "dataforrest-events-adapter-v1",
        normalizedContractVersion: "provider-observation-v1",
        mapperKey: "courtyard-provider-observation",
        mapperVersion: "1",
        identityNamespaceKey: "dataforrest-courtyard-records-v1",
        recordIdScopes: [
          "catalog-pack-v1",
          "catalog-card-v1",
          "pull-v1",
          "trade-v1",
        ],
      },
    }],
    connections: [{
      id: ids.profile,
      displayName: "Shared DataForrest",
      sourceTypeKey: "dataforrest-events-v1",
      connectionTypeKey: "dataforrest-events-connection-v1",
      state: "draft",
      requestLimit: 2,
      activeRevisionId: null,
      activeRevision: null,
      recoveryFence: null,
      latestRevision: {
        id: ids.revision,
        revisionNumber: 1,
        sourceAdapterVersion: "dataforrest-events-adapter-v1",
        state: "candidate",
        endpointHost: "dataforrest.example",
        credentialConfigured: true,
        credentialMask: "••••••••",
        encryptionKeyVersion: 1,
        healthGeneration: "0",
        revokedAt: null,
        test: {
          jobId: ids.source,
          connectionRevisionId: ids.revision,
          current: true,
          state: "fenced",
          outcome: "failure",
          safeCode: "TEST_RESULT_PUBLICATION_INCOMPLETE",
          requestedAt: "2026-08-21T12:00:01.000Z",
          testedAt: "2026-08-21T12:00:02.000Z",
        },
        createdAt: "2026-08-21T12:00:00.000Z",
      },
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z",
    }],
    sources: [],
  });
  const serialized = JSON.stringify(catalog);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("bearerCredential"), false);
  assert.equal(serialized.includes("configurationCiphertext"), false);
  assert.equal(serialized.includes("dataforrest.example"), true);
  assert.equal(serialized.includes("TEST_RESULT_PUBLICATION_INCOMPLETE"), true);
});

test("cursor reset preview binds one provider, generation, and typed consequence", () => {
  const preview = providerSourceCursorResetPreviewSchema.parse({
    providerId: ids.provider,
    provider: "courtyard",
    sourceInstanceId: ids.source,
    sourceRevisionId: ids.sourceRevision,
    sourceState: "paused",
    cursorGeneration: "3",
    cursorFingerprint: "a".repeat(64),
    confirmation: "RESET COURTYARD",
    consequence:
      "The saved cursor will be cleared and the next resume will start from Feed start.",
  });
  assert.equal(preview.confirmation, "RESET COURTYARD");
  assert.equal(
    providerSourceCursorResetPreviewSchema.safeParse({
      ...preview,
      sourceState: "active",
    }).success,
    false,
  );
  assert.equal(
    providerSourceCursorResetPreviewSchema.safeParse({
      ...preview,
      cursorGeneration: "0",
    }).success,
    false,
  );
});

test("failure receipts carry only stable correlation and a bounded safe code", () => {
  const receipt = providerSourceAdminAuditReceiptSchema.parse({
    actor: "current_operator",
    action: "source_resumed",
    subjectType: "provider_source",
    subjectId: ids.source,
    revisionId: ids.sourceRevision,
    outcome: "failure",
    safeCode: "SOURCE_CONFLICT",
    occurredAt: "2026-08-21T12:00:00.000Z",
  });
  assert.equal(receipt.outcome, "failure");
  assert.equal(
    providerSourceAdminAuditReceiptSchema.safeParse({
      ...receipt,
      safeCode: "database constraint includes secret",
    }).success,
    false,
  );
});
