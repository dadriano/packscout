import assert from "node:assert/strict";
import { test } from "node:test";
import { AesGcmSourceConnectionConfigurationCipher } from "./source-connection-configuration-cipher.ts";

const key = new Uint8Array(32).fill(17);
const scope = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  connectionProfileId: "00000000-0000-4000-8000-000000000002",
  connectionRevisionId: "00000000-0000-4000-8000-000000000003",
} as const;

test("connection configuration encryption binds organization, profile, and revision", () => {
  const cipher = new AesGcmSourceConnectionConfigurationCipher({
    primaryVersion: 1,
    keys: new Map([[1, key]]),
  });
  const plaintext = JSON.stringify({
    endpoint: "https://dataforrest.example/v1/events",
    bearerToken: "protected-bearer",
  });
  const encrypted = cipher.encrypt(plaintext, scope);
  assert.equal(cipher.decrypt(encrypted, scope), plaintext);
  assert.equal(encrypted.keyVersion, 1);
  assert.equal(Buffer.from(encrypted.ciphertext).toString("utf8").includes("protected-bearer"), false);
  for (const foreign of [
    { ...scope, organizationId: "00000000-0000-4000-8000-000000000009" },
    { ...scope, connectionProfileId: "00000000-0000-4000-8000-000000000009" },
    { ...scope, connectionRevisionId: "00000000-0000-4000-8000-000000000009" },
  ]) {
    assert.throws(
      () => cipher.decrypt(encrypted, foreign),
      /could not be decrypted/u,
    );
  }
});

test("key rotation decrypts old configuration and writes only the primary version", () => {
  const oldCipher = new AesGcmSourceConnectionConfigurationCipher({
    primaryVersion: 1,
    keys: new Map([[1, key]]),
  });
  const encrypted = oldCipher.encrypt("{\"bearerToken\":\"old\"}", scope);
  const rotated = new AesGcmSourceConnectionConfigurationCipher({
    primaryVersion: 2,
    keys: new Map([
      [1, key],
      [2, new Uint8Array(32).fill(29)],
    ]),
  });
  assert.equal(rotated.decrypt(encrypted, scope), "{\"bearerToken\":\"old\"}");
  assert.equal(rotated.encrypt("{\"bearerToken\":\"new\"}", scope).keyVersion, 2);
});
