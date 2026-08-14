import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseSafeProtectedJsonEvidence,
  decodeDatabaseSafeProtectedJsonEvidence,
} from "./protected-json-evidence.ts";

test("DB-owned evidence envelopes round-trip provider values that resemble legacy tags", () => {
  const providerValue = {
    encoding: "json-text-v1",
    json: '{"provider":"authored"}',
  };

  const stored = databaseSafeProtectedJsonEvidence(providerValue);
  assert.deepEqual(decodeDatabaseSafeProtectedJsonEvidence(stored), providerValue);
  assert.deepEqual(
    decodeDatabaseSafeProtectedJsonEvidence(providerValue),
    providerValue,
    "legacy raw provider values are not interpreted as database envelopes",
  );
});

test("malformed DB-owned evidence envelopes return a bounded unavailable sentinel", () => {
  const malformed = {
    __packscout_protected_json_v1: {
      kind: "text",
      json: "not-json",
    },
  };

  assert.doesNotThrow(() => decodeDatabaseSafeProtectedJsonEvidence(malformed));
  assert.deepEqual(decodeDatabaseSafeProtectedJsonEvidence(malformed), {
    encoding: "json-unavailable-v1",
    reason: "protected_evidence_unavailable",
  });
});
