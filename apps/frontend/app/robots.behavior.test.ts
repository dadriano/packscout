import assert from "node:assert/strict";
import { test } from "node:test";
import robots from "./robots";
import { GATED_INDEX_EXCLUSIONS } from "@/lib/access-gate.server";

test("with no readable gate status the served robots policy fails closed", async () => {
  // The test process has no backend configured, so the gate status is
  // unknown — the exclusions must hold rather than opening the site up.
  const policy = await robots();
  const rule = Array.isArray(policy.rules) ? policy.rules[0] : policy.rules;
  assert.equal(rule?.allow, "/");
  assert.deepEqual(rule?.disallow, [...GATED_INDEX_EXCLUSIONS]);
});
