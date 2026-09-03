import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderDatabaseLifecycle } from "./provider-database.ts";

const providerId = "79ad49f7-94a3-4fb9-a03e-58506e802c62";

test("provider lifecycle validates identity and connection bounds before connecting", async () => {
  assert.throws(
    () => createProviderDatabaseLifecycle({
      databaseUrl: "https://database.example/packscout_beezie",
      providerId,
      providerKey: "beezie",
    }),
    /database URL is invalid/,
  );
  assert.throws(
    () => createProviderDatabaseLifecycle({
      databaseUrl: "postgresql://user:secret@database.example/packscout_beezie",
      providerId,
      providerKey: "beezie",
      connectionLimit: 0,
    }),
    /connection limit is invalid/,
  );
  assert.throws(
    () => createProviderDatabaseLifecycle({
      databaseUrl: "postgresql://user:secret@database.example/packscout_beezie",
      providerId,
      providerKey: "Beezie",
    }),
    /Provider key is invalid/,
  );
});

test("provider lifecycle rejects unsupported and contradictory TLS policies before connecting", () => {
  for (const query of ["sslmode=verify-ca", "sslmode=unknown", "sslmode=verify-full&sslaccept=accept_invalid_certs"]) {
    assert.throws(() => createProviderDatabaseLifecycle({
      databaseUrl: `postgresql://test:synthetic-password@database.example/packscout_beezie?${query}`,
      providerId,
      providerKey: "beezie",
    }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes("synthetic-password"), false);
      return true;
    });
  }
});
