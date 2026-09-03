import assert from "node:assert/strict";
import { test } from "node:test";
import { AesGcmProviderCredentialCipher } from "./provider-credential-cipher.ts";
import { CipherProviderDatabaseCredentialResolver } from
  "./provider-database-credential-resolver.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const providerId = "00000000-0000-4000-8000-000000000002";
const credentialVersionId = "00000000-0000-4000-8000-000000000003";

test("database credentials resolve through the existing provider-scoped v1 cipher", async () => {
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: 3,
    keys: new Map([[3, new Uint8Array(32).fill(17)]]),
  });
  const encryptedCredential = cipher.encrypt(
    JSON.stringify({ username: "packscout_clutchpacks_app", password: "secret" }),
    { organizationId, providerId, revisionId: credentialVersionId },
  );

  const resolved = await new CipherProviderDatabaseCredentialResolver(cipher)
    .resolve({
      organizationId,
      providerId,
      credentialVersionId,
      encryptedCredential,
    });

  assert.deepEqual(resolved, {
    username: "packscout_clutchpacks_app",
    password: "secret",
  });
});

test("database credentials stay bound to the provider and version scope", async () => {
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: 1,
    keys: new Map([[1, new Uint8Array(32).fill(23)]]),
  });
  const encryptedCredential = cipher.encrypt(
    JSON.stringify({ username: "provider_app", password: "not-in-errors" }),
    { organizationId, providerId, revisionId: credentialVersionId },
  );
  const resolver = new CipherProviderDatabaseCredentialResolver(cipher);

  await assert.rejects(
    resolver.resolve({
      organizationId,
      providerId: "00000000-0000-4000-8000-000000000004",
      credentialVersionId,
      encryptedCredential,
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch(String(error), /not-in-errors/u);
      return true;
    },
  );
});

test("database credential plaintext must be the exact username/password object", async () => {
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: 1,
    keys: new Map([[1, new Uint8Array(32).fill(29)]]),
  });
  const encryptedCredential = cipher.encrypt(
    JSON.stringify({ username: "provider_app", password: "secret", host: "ignored" }),
    { organizationId, providerId, revisionId: credentialVersionId },
  );

  await assert.rejects(
    new CipherProviderDatabaseCredentialResolver(cipher).resolve({
      organizationId,
      providerId,
      credentialVersionId,
      encryptedCredential,
    }),
    /Provider database credential is invalid/u,
  );
});
