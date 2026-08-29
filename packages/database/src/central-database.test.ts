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
