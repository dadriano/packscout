import assert from "node:assert/strict";
import { test } from "node:test";
import {
  importRunDetailLocationSchema,
  importRunDetailPath,
  importRunDetailQuerySchema,
} from "./import-run-detail.ts";

const providerId = "20000000-0000-4000-8000-000000000002";
const runId = "20000000-0000-4000-8000-000000000004";
const path = `/runs/${runId}?providerId=${providerId}`;

test("run detail requires exactly one UUID provider and keeps the existing route family", () => {
  assert.deepEqual(importRunDetailQuerySchema.parse({ providerId }), { providerId });
  assert.deepEqual(importRunDetailLocationSchema.parse({ providerId, runId }), { providerId, runId });
  assert.equal(importRunDetailPath({ providerId, runId }), path);
  for (const query of [{}, { providerId: "" }, { providerId: "courtyard" },
    { providerId: [providerId, providerId] }, { providerId, organizationId: runId }]) {
    assert.equal(importRunDetailQuerySchema.safeParse(query).success, false);
  }
  assert.equal(importRunDetailLocationSchema.safeParse({ providerId, runId: "not-a-run" }).success, false);
});
