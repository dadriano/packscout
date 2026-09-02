import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { appendProviderActivityOutbox, buildProviderActivityOutboxRow,
  type ProviderActivityOutboxInput } from "./provider-local-evidence.ts";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { readExistingSourceQuarantineKeys } from "./provider-mixed-page-quarantine.ts";
import { PROVIDER_MIXED_PAGE_MAX_RECORDS, ProviderMixedPageContractError,
  type ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";

function input(): ProviderActivityOutboxInput {
  return { eventType: "provider.quarantine.opened", severity: "warning", dedupeKey: "synthetic:open",
    recoveryKey: "synthetic:recovery", localRunId: randomUUID(), localQuarantineId: randomUUID(),
    title: " Synthetic quarantine ", summary: " Synthetic review required. ",
    evidence: { selectedCount: 1, quarantineState: "open" }, eventAt: new Date("2026-08-31T00:00:00.000Z") };
}

test("single and batch activity payloads share validation and the unchanged identity digest", async () => {
  const rows: ReturnType<typeof buildProviderActivityOutboxRow>[] = [];
  const transaction = { provider_activity_outbox: { async create({ data }: { data: typeof rows[number] }) {
    rows.push(data);
  } } } as unknown as ProviderTransactionClient;
  const value = input(), id = await appendProviderActivityOutbox(transaction, value);
  assert.equal(rows[0]!.id, id);
  for (const row of [rows[0]!, buildProviderActivityOutboxRow(value)]) {
    const identity = { id: row.id, eventType: value.eventType, severity: value.severity,
      dedupeKey: value.dedupeKey, recoveryKey: value.recoveryKey, localRunId: value.localRunId,
      localQuarantineId: value.localQuarantineId, title: "Synthetic quarantine", summary: "Synthetic review required.",
      evidence: { quarantineState: "open", selectedCount: 1 }, eventAt: value.eventAt.toISOString() };
    assert.equal(row.event_digest, createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
  }
});

test("activity builders reject protected or unbounded evidence before any single write without exposing values", async () => {
  let writes = 0;
  const transaction = { provider_activity_outbox: { async create() { writes += 1; } } } as unknown as ProviderTransactionClient;
  const marker = "synthetic-sensitive-value";
  const invalid: ProviderActivityOutboxInput[] = [
    { ...input(), localRunId: marker }, { ...input(), localQuarantineId: marker },
    { ...input(), eventType: `event with space ${marker}` },
    { ...input(), title: `\u0000${marker}` }, { ...input(), summary: "x".repeat(501) },
    { ...input(), evidence: { token: marker } }, { ...input(), evidence: { unreviewedKey: marker } },
    { ...input(), evidence: { selectedCount: -1 } },
  ];
  for (const value of invalid) {
    assert.throws(() => buildProviderActivityOutboxRow(value), (error: unknown) =>
      error instanceof RangeError && !error.message.includes(marker));
    await assert.rejects(appendProviderActivityOutbox(transaction, value), RangeError);
  }
  assert.equal(writes, 0);
});

test("source-key prefetch rejects incomplete and oversized input before a database read", async () => {
  let reads = 0;
  const transaction = { quarantine_records: { async findMany() { reads += 1; return []; } } } as unknown as ProviderTransactionClient;
  const record: ProviderMixedPageRecord = { providerId: randomUUID(), position: 0, kind: "pull",
    disposition: "quarantine", candidate: {}, sourceRecordKey: `source:${"a".repeat(64)}`,
    reasonCode: "NORMALIZED_CANDIDATE_INVALID", fieldPath: null, sanitizedSummary: "Synthetic mapping failure." };
  for (const field of ["sourceRecordKey", "reasonCode", "fieldPath", "sanitizedSummary"] as const) {
    await assert.rejects(readExistingSourceQuarantineKeys(transaction, [{ ...record, [field]: undefined }]), ProviderMixedPageContractError);
  }
  await assert.rejects(readExistingSourceQuarantineKeys(transaction,
    Array.from({ length: PROVIDER_MIXED_PAGE_MAX_RECORDS + 1 }, () => record)), ProviderMixedPageContractError);
  assert.equal(reads, 0);
  assert.deepEqual(await readExistingSourceQuarantineKeys(transaction, []), new Set());
  assert.equal(reads, 0);
});
