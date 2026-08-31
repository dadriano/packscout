import assert from "node:assert/strict";
import test from "node:test";
import { readProviderManualImportDatabaseConfiguration } from "./provider-manual-import-database-configuration.ts";
import { ProviderManualImportLocalError } from "./provider-manual-import-local-runtime.ts";

const remote: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  PACKSCOUT_DATABASE_MODE: "remote",
  PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "control.example.test",
  PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "provider.example.test",
  PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@control.example.test:5432/packscout?sslmode=require&sslaccept=strict",
};

test("manual import developer worker accepts explicitly allowed remote databases with certificate verification", () => {
  const configuration = readProviderManualImportDatabaseConfiguration(remote);
  assert.equal(configuration.runtimePolicy.mode, "remote");
  assert.equal(configuration.centralDatabaseUrl, remote.PACKSCOUT_CENTRAL_DATABASE_URL);
  assert.doesNotThrow(() => configuration.runtimePolicy.destinationPolicy.assertAllowed({
    host: "provider.example.test", port: 5432, sslMode: "verify-full",
  }));
  for (const node of [
    { host: "provider.example.test.attacker.test", port: 5432, sslMode: "verify-full" },
    { host: "provider.example.test", port: 55435, sslMode: "verify-full" },
    { host: "provider.example.test", port: 5432, sslMode: "require" },
  ]) assert.throws(() => configuration.runtimePolicy.destinationPolicy.assertAllowed(node));
});

test("manual import fails closed before creating clients and never returns credentials in errors", () => {
  for (const patch of [
    { NODE_ENV: "production" }, { PACKSCOUT_DATABASE_MODE: undefined },
    { PACKSCOUT_DATABASE_MODE: "remtoe" }, { PACKSCOUT_DATABASE_MODE: "" },
    { PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "*.example.test" },
    { PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: undefined },
    { PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: undefined },
    { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@other.example.test:5432/packscout?sslmode=require&sslaccept=strict" },
    { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@control.example.test:5432/packscout?sslmode=require" },
    { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@control.example.test:5432/packscout?sslmode=require&sslaccept=accept_invalid_certs" },
    { PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@control.example.test:5432/postgres?sslmode=require&sslaccept=strict" },
  ]) assert.throws(() => readProviderManualImportDatabaseConfiguration({ ...remote, ...patch }), error => {
    assert.ok(error instanceof ProviderManualImportLocalError);
    assert.equal(error.code, "PROVIDER_IMPORT_CONFIGURATION_INVALID");
    assert.equal(error.message.includes("synthetic-secret"), false);
    return true;
  });
});

test("manual import local mode remains the default and does not infer hosts from a provider DSN", () => {
  const configuration = readProviderManualImportDatabaseConfiguration({ NODE_ENV: "development",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://app:synthetic-secret@127.0.0.1:55431/packscout",
    PACKSCOUT_PROVIDER_DATABASE_URL: "postgresql://app:must-not-use@provider.example.test/packscout_phygitals",
  });
  assert.equal(configuration.runtimePolicy.mode, "local");
  assert.doesNotThrow(() => configuration.runtimePolicy.destinationPolicy.assertAllowed({
    host: "127.0.0.1", port: 55435, sslMode: "disable",
  }));
  assert.throws(() => configuration.runtimePolicy.destinationPolicy.assertAllowed({
    host: "provider.example.test", port: 5432, sslMode: "verify-full",
  }));
});
