import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isQuarantineReasonRetryable,
  quarantineIdSchema,
  quarantineListQuerySchema,
  quarantineRetryBulkRequestSchema,
} from "./quarantine.ts";

test("immutable source conflict reasons are exactly non-retryable", () => {
  for (const reasonCode of [
    "IDENTITY_CONFLICT",
    "CATALOG_IDENTITY_CONFLICT",
    "IMMUTABLE_EVENT_CONFLICT",
  ]) {
    assert.equal(isQuarantineReasonRetryable(reasonCode), false);
  }
  assert.equal(isQuarantineReasonRetryable("SOURCE_IDENTITY_MISMATCH"), true);
  assert.equal(isQuarantineReasonRetryable("identity_conflict"), true);
  assert.equal(isQuarantineReasonRetryable("IDENTITY_CONFLICT_REPAIRED"), true);
});

test("single quarantine identifiers must be UUIDs", () => {
  assert.equal(quarantineIdSchema.safeParse("not-a-quarantine-id").success, false);
});

const id = "30000000-0000-4000-8000-000000000001";

test("quarantine list inputs apply a bounded default without accepting raw selectors", () => {
  assert.deepEqual(quarantineListQuerySchema.parse({}), { limit: 50 });
  assert.equal(quarantineListQuerySchema.safeParse({ limit: 101 }).success, false);
  assert.equal(
    quarantineListQuerySchema.safeParse({ rawPayload: "anything" }).success,
    false,
  );
});

test("bulk quarantine retry IDs are unique and bounded", () => {
  assert.deepEqual(quarantineRetryBulkRequestSchema.parse({ quarantineIds: [id] }), {
    quarantineIds: [id],
  });
  assert.equal(
    quarantineRetryBulkRequestSchema.safeParse({ quarantineIds: [id, id] }).success,
    false,
  );
  assert.equal(
    quarantineRetryBulkRequestSchema.safeParse({ quarantineIds: [] }).success,
    false,
  );
});
