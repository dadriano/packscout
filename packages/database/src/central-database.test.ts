import assert from "node:assert/strict";
import { test } from "node:test";
import { createCentralDatabaseLifecycle } from "./central-database.ts";

test("central lifecycle validates connection bounds before connecting", () => {
  assert.throws(
    () => createCentralDatabaseLifecycle({
      databaseUrl: "https://database.example/packscout",
    }),
    /database URL is invalid/,
  );
  assert.throws(
    () => createCentralDatabaseLifecycle({
      databaseUrl: "postgresql://user:secret@database.example/packscout",
      connectionLimit: 33,
    }),
    /connection limit is invalid/,
  );
});

test("central lifecycle rejects unsupported and contradictory TLS policies before connecting", () => {
  for (const query of ["sslmode=verify-ca", "sslmode=unknown", "sslmode=verify-full&sslaccept=accept_invalid_certs"]) {
    assert.throws(() => createCentralDatabaseLifecycle({
      databaseUrl: `postgresql://test:synthetic-password@database.example/packscout?${query}`,
    }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes("synthetic-password"), false);
      return true;
    });
  }
});
