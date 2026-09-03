import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderDatabaseDestinationPolicy,
  ProviderDatabaseDestinationPolicyError,
} from "./provider-database-destination-policy.ts";

test("destination policy defaults to verify-full and rejects local plaintext", () => {
  const policy = new ProviderDatabaseDestinationPolicy({
    allowedHosts: ["*.db.internal"],
  });

  policy.assertAllowed({
    host: "clutchpacks.db.internal",
    port: 5432,
    sslMode: "verify-full",
  });
  assert.throws(() => policy.assertAllowed({
    host: "clutchpacks.db.internal",
    port: 5432,
    sslMode: "disable",
  }), ProviderDatabaseDestinationPolicyError);
});

test("local plaintext is available only through an explicit server-owned policy", () => {
  const policy = new ProviderDatabaseDestinationPolicy({
    allowedHosts: ["127.0.0.1"],
    allowedPorts: [5432],
    allowedSslModes: ["disable"],
  });

  policy.assertAllowed({
    host: "127.0.0.1",
    port: 5432,
    sslMode: "disable",
  });
  assert.throws(() => policy.assertAllowed({
    host: "attacker.example",
    port: 5432,
    sslMode: "disable",
  }), ProviderDatabaseDestinationPolicyError);
  assert.throws(() => policy.assertAllowed({
    host: "127.0.0.1",
    port: 5432,
    sslMode: "verify-full",
  }), ProviderDatabaseDestinationPolicyError);
});
