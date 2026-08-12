import assert from "node:assert/strict";
import { test } from "node:test";
import { AesGcmProviderCredentialCipher } from "./provider-credential-cipher.ts";

const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  providerId: "00000000-0000-4000-8000-000000000002",
  revisionId: "00000000-0000-4000-8000-000000000003",
};

test("AES-GCM credentials rotate ciphertext and bind to provider revision scope", () => {
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: 7,
    keys: new Map([[7, new Uint8Array(32).fill(19)]]),
  });
  const plaintext = "fixture-bearer-secret";
  const first = cipher.encrypt(plaintext, scope);
  const second = cipher.encrypt(plaintext, scope);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.equal(cipher.decrypt(first, scope), plaintext);
  assert.throws(() =>
    cipher.decrypt(first, {
      ...scope,
      revisionId: "00000000-0000-4000-8000-000000000004",
    }),
  );
  assert.doesNotMatch(JSON.stringify(first), new RegExp(plaintext));
});

test("credential keyring requires a 32-byte primary key", () => {
  assert.throws(
    () =>
      new AesGcmProviderCredentialCipher({
        primaryVersion: 1,
        keys: new Map([[1, new Uint8Array(16)]]),
      }),
    /keyring is invalid/,
  );
});
