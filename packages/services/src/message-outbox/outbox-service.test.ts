import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EmailMessageOutboxService,
  type EmailMessageOutboxEnqueueQueue,
} from "./outbox-service.ts";

const now = new Date("2026-08-22T12:00:00.000Z");
const clock = { now: () => now };

type EnqueueCall = Parameters<EmailMessageOutboxEnqueueQueue["enqueue"]>[0];

function recordingQueue(
  result?: Awaited<ReturnType<EmailMessageOutboxEnqueueQueue["enqueue"]>>,
): { queue: EmailMessageOutboxEnqueueQueue; calls: EnqueueCall[] } {
  const calls: EnqueueCall[] = [];
  return {
    calls,
    queue: {
      async enqueue(input) {
        calls.push(input);
        return (
          result ?? {
            status: "enqueued",
            intentId: "11111111-1111-4111-8111-111111111111",
            deduplicated: false,
          }
        );
      },
    },
  };
}

const command = {
  kind: "access_approved",
  input: { plan: "beta" },
  recipient: "person@example.test",
  idempotencyKey: "access:decision:user-1",
  source: "closed_beta",
};

test("enqueueing records the intent durably through the queue alone — no delivery collaborator exists to block or fail it", async () => {
  // The constructor takes a queue and a clock and nothing else: there is no
  // delivery boundary, adapter, or network dependency to be down. That is
  // the structural proof that enqueueing succeeds while delivery is
  // unconfigured or unreachable, and that a caller's own operation never
  // waits on a delivery outcome.
  const { queue, calls } = recordingQueue();
  const service = new EmailMessageOutboxService({ queue, clock });
  const result = await service.enqueueEmailMessage(command);
  assert.deepEqual(result, {
    status: "enqueued",
    intentId: "11111111-1111-4111-8111-111111111111",
    deduplicated: false,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    kind: "access_approved",
    input: { plan: "beta" },
    recipient: "person@example.test",
    idempotencyKey: "access:decision:user-1",
    source: "closed_beta",
    dueAt: now,
    now,
    sourceActiveLimit: 10_000,
  });
});

test("a caller-chosen due time and source limit pass through; recipients are normalized", async () => {
  const { queue, calls } = recordingQueue();
  const service = new EmailMessageOutboxService({
    queue,
    clock,
    sourceActiveLimit: 25,
  });
  const dueAt = new Date(now.getTime() + 60_000);
  await service.enqueueEmailMessage({
    ...command,
    recipient: "  Person@example.test  ",
    dueAt,
  });
  assert.equal(calls[0]?.dueAt, dueAt);
  assert.equal(calls[0]?.recipient, "Person@example.test");
  assert.equal(calls[0]?.sourceActiveLimit, 25);
});

test("duplicate and over-budget enqueues surface the queue's convergence and refusal", async () => {
  const deduplicated = recordingQueue({
    status: "enqueued",
    intentId: "22222222-2222-4222-8222-222222222222",
    deduplicated: true,
  });
  assert.deepEqual(
    await new EmailMessageOutboxService({
      queue: deduplicated.queue,
      clock,
    }).enqueueEmailMessage(command),
    {
      status: "enqueued",
      intentId: "22222222-2222-4222-8222-222222222222",
      deduplicated: true,
    },
  );
  const rejected = recordingQueue({
    status: "rejected",
    errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
    activeCount: 10_000,
  });
  assert.deepEqual(
    await new EmailMessageOutboxService({
      queue: rejected.queue,
      clock,
    }).enqueueEmailMessage(command),
    {
      status: "rejected",
      errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
      activeCount: 10_000,
    },
  );
});

test("invalid requests are explicit results and never reach the queue", async () => {
  const { queue, calls } = recordingQueue();
  const service = new EmailMessageOutboxService({ queue, clock });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const invalidCommands = [
    { ...command, kind: "Not A Kind" },
    { ...command, recipient: "not-an-address" },
    { ...command, recipient: `${"x".repeat(320)}@example.test` },
    { ...command, idempotencyKey: "" },
    { ...command, idempotencyKey: "has whitespace" },
    { ...command, source: "Closed Beta" },
    { ...command, input: { blob: "x".repeat(20_000) } },
    { ...command, input: circular },
    { ...command, dueAt: new Date("invalid") },
  ];
  for (const invalid of invalidCommands) {
    const result = await service.enqueueEmailMessage(invalid);
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.errorCode, "EMAIL_OUTBOX_REQUEST_INVALID");
      assert.ok(result.reason.length > 0);
    }
  }
  assert.equal(calls.length, 0);
});

test("an absent input is stored as null rather than refused", async () => {
  const { queue, calls } = recordingQueue();
  const service = new EmailMessageOutboxService({ queue, clock });
  await service.enqueueEmailMessage({ ...command, input: undefined });
  assert.equal(calls[0]?.input, null);
});

test("the source limit option is bounded at construction", () => {
  const { queue } = recordingQueue();
  for (const limit of [0, -1, 1.5, 1_000_001]) {
    assert.throws(
      () =>
        new EmailMessageOutboxService({ queue, clock, sourceActiveLimit: limit }),
      RangeError,
    );
  }
});
