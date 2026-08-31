import assert from "node:assert/strict";
import { test } from "node:test";
import { readDatabaseRuntimePolicy } from "./database-runtime-policy.ts";

const remote = {
  NODE_ENV: "development",
  PACKSCOUT_DATABASE_MODE: "remote",
  PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "central.example.test",
  PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "provider.example.test,second.example.test",
};
const central = "postgresql://synthetic:synthetic@central.example.test:5432/packscout";

test("local development defaults to loopback review databases and cannot infer remote access", () => {
  const policy = readDatabaseRuntimePolicy({ NODE_ENV: "development" });
  assert.equal(policy.mode, "local");
  assert.doesNotThrow(() => policy.assertCentralDatabaseUrl("postgresql://test@127.0.0.1:55431/packscout"));
  for (const port of [55432, 55433, 55434, 55435]) {
    assert.doesNotThrow(() => policy.destinationPolicy.assertAllowed({ host: "127.0.0.1", port, sslMode: "disable" }));
  }
  assert.throws(() => policy.assertCentralDatabaseUrl(`${central}?sslmode=verify-full`));
  assert.throws(() => policy.destinationPolicy.assertAllowed({ host: "provider.example.test", port: 5432, sslMode: "verify-full" }));
});

test("explicit remote mode permits only exact provider hosts with verified TLS on 5432", () => {
  const policy = readDatabaseRuntimePolicy(remote);
  assert.equal(policy.mode, "remote");
  for (const host of ["provider.example.test", "second.example.test"]) {
    assert.doesNotThrow(() => policy.destinationPolicy.assertAllowed({ host, port: 5432, sslMode: "verify-full" }));
  }
  for (const target of [
    { host: "127.0.0.1", port: 55432, sslMode: "disable" },
    { host: "sub.provider.example.test", port: 5432, sslMode: "verify-full" },
    { host: "provider.example.test.evil.test", port: 5432, sslMode: "verify-full" },
    { host: "provider.example.test", port: 55432, sslMode: "verify-full" },
    { host: "provider.example.test", port: 5432, sslMode: "require" },
    { host: "provider.example.test", port: 5432, sslMode: "verify-ca" },
    { host: "provider.example.test", port: 5432, sslMode: "disable" },
  ]) assert.throws(() => policy.destinationPolicy.assertAllowed(target));
});

test("remote central connections require exact authority, target database, and supported strict TLS", () => {
  const policy = readDatabaseRuntimePolicy(remote);
  for (const query of ["sslmode=verify-full", "sslmode=require&sslaccept=strict", "sslmode=verify-full&sslaccept=strict"]) {
    assert.doesNotThrow(() => policy.assertCentralDatabaseUrl(`${central}?${query}`));
  }
  for (const query of ["", "sslmode=disable", "sslmode=prefer", "sslmode=require", "sslmode=verify-ca",
    "sslmode=verify-full&sslaccept=accept_invalid_certs", "sslmode=require&sslaccept=accept_invalid_certs",
    "sslmode=verify-full&sslmode=disable", "sslmode=require&sslaccept=strict&sslaccept=accept_invalid_certs",
    "sslmode=verify-full&host=/tmp", "sslmode=verify-full&hostaddr=127.0.0.1"]) {
    assert.throws(() => policy.assertCentralDatabaseUrl(`${central}?${query}`));
  }
  for (const url of [
    central.replace("central.example.test", "other.example.test"),
    central.replace(":5432", ":55431"), central.replace("/packscout", "/other"),
    central.replace("synthetic:synthetic@", ""), central.replace("postgresql:", "https:"),
  ]) assert.throws(() => policy.assertCentralDatabaseUrl(`${url}?sslmode=verify-full`));
});

test("unknown modes, wildcard hosts, invalid authorities and normalized duplicates fail closed", () => {
  for (const mode of ["", "neon", "REMOTE", " remote "]) {
    assert.throws(() => readDatabaseRuntimePolicy({ ...remote, PACKSCOUT_DATABASE_MODE: mode }), /PACKSCOUT_DATABASE_MODE/u);
  }
  for (const hosts of [undefined, "", "*.example.test", "https://provider.example.test", "user@provider.example.test", "one.test,,two.test", "one.test,ONE.test.", "one.test/path"]) {
    assert.throws(() => readDatabaseRuntimePolicy({ ...remote, PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: hosts }), /exact database hosts/u);
    const policy = readDatabaseRuntimePolicy({ ...remote, PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: hosts });
    assert.throws(() => policy.assertCentralDatabaseUrl(`${central}?sslmode=verify-full`), /exact database hosts/u);
  }
});

test("production stays remote-only while local overrides remain explicit", () => {
  assert.equal(readDatabaseRuntimePolicy({ ...remote, NODE_ENV: "production", PACKSCOUT_DATABASE_MODE: undefined }).mode, "remote");
  assert.throws(() => readDatabaseRuntimePolicy({ ...remote, NODE_ENV: "production", PACKSCOUT_DATABASE_MODE: "local" }));
  const policy = readDatabaseRuntimePolicy({}, { localCentralPort: 55439, centralDatabaseName: "packscout_test", localProviderPorts: [55440] });
  assert.doesNotThrow(() => policy.assertCentralDatabaseUrl("postgresql://test@127.0.0.1:55439/packscout_test"));
  assert.throws(() => policy.assertCentralDatabaseUrl("postgresql://test@127.0.0.1:55431/packscout_test"));
});

test("configuration errors never include credentials or the supplied URL", () => {
  const secret = "do-not-log-this-password";
  const url = `postgresql://user:${secret}@unlisted.example.test/packscout?sslmode=disable`;
  assert.throws(() => readDatabaseRuntimePolicy(remote).assertCentralDatabaseUrl(url), (error: Error) => {
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(url), false);
    return true;
  });
});
