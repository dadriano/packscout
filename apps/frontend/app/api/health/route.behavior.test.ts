import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "./route";

test("GET /api/health reports the frontend service state", async () => {
  const response = GET();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "packscout-frontend",
    framework: "next",
  });
});
