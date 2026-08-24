import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createMessageDeliveryAuditSink } from "./message-delivery-audit.ts";

const intentId = "b6f6f4a0-3a89-4a90-8f6e-6a1d2c3b4a5f";

function createCapturingDatabase() {
  const written: unknown[] = [];
  const database = {
    audit_events: {
      async create(args: { data: unknown }) {
        written.push(args.data);
        return args.data;
      },
    },
  } as unknown as Parameters<typeof createMessageDeliveryAuditSink>[0]["database"];
  return { database, written };
}

test("retry audit records carry a pseudonymous recipient reference, never the address", async () => {
  const { database, written } = createCapturingDatabase();
  const sink = createMessageDeliveryAuditSink({
    database,
    actorPseudonymKey: randomBytes(32),
  });
  await sink.append({
    organizationId: "00000000-0000-4000-8000-000000000010",
    actorId: "00000000-0000-4000-8000-000000000001",
    action: "message_delivery.retry",
    intentId,
    recipient: "ada@example.test",
    kind: "access_approved",
    outcome: "success",
    occurredAt: new Date("2026-08-23T09:00:00.000Z"),
  });

  assert.equal(written.length, 1);
  const record = written[0] as {
    action: string;
    subject_type: string;
    subject_id: string;
    outcome: string;
    metadata_json: Record<string, unknown>;
  };
  assert.equal(record.action, "message_delivery.retry");
  assert.equal(record.subject_type, "email_message_intent");
  // The opaque queue UUID is the stable subject; it is not personal data.
  assert.equal(record.subject_id, intentId);
  assert.equal(record.outcome, "success");
  assert.equal(record.metadata_json.kind, "access_approved");
  // The recipient is stored keyed, correlatable but not readable.
  assert.match(
    String(record.metadata_json.recipientReference),
    /^message-delivery:[0-9a-f]{12}$/,
  );
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /ada@example\.test|example\.test/);
});

test("the same recipient keys to the same reference and a refusal records its reason", async () => {
  const { database, written } = createCapturingDatabase();
  const sink = createMessageDeliveryAuditSink({
    database,
    actorPseudonymKey: randomBytes(32),
  });
  const base = {
    organizationId: "00000000-0000-4000-8000-000000000010",
    actorId: "00000000-0000-4000-8000-000000000001",
    action: "message_delivery.retry" as const,
    intentId,
    recipient: "grace@example.test",
    kind: "welcome",
    occurredAt: new Date("2026-08-23T09:00:00.000Z"),
  };
  await sink.append({ ...base, outcome: "success" });
  await sink.append({
    ...base,
    outcome: "failure",
    reason: "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL",
  });
  // A retry with no readable target still records the attempt.
  await sink.append({
    ...base,
    recipient: null,
    kind: null,
    outcome: "failure",
    reason: "MESSAGE_DELIVERY_UNAVAILABLE",
  });

  const [first, second, third] = written as {
    metadata_json: Record<string, unknown>;
  }[];
  assert.equal(
    first?.metadata_json.recipientReference,
    second?.metadata_json.recipientReference,
  );
  assert.equal(
    second?.metadata_json.reason,
    "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL",
  );
  assert.equal("recipientReference" in (third?.metadata_json ?? {}), false);
  assert.equal(third?.metadata_json.reason, "MESSAGE_DELIVERY_UNAVAILABLE");
});
