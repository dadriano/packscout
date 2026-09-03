import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
} from "@packscout/services";
import {
  createOperatorAccountCreatedNotifier,
  OPERATOR_ACCOUNT_MESSAGE_SOURCE,
  operatorAccountCreatedNoticeIdempotencyKey,
} from "./operator-account-created-notice.ts";

const operatorId = "00000000-0000-4000-8000-000000000002";
const toEmail = "operator@packscout.test";

function createHarness(
  enqueue?: (
    command: EnqueueEmailMessageCommand,
  ) => Promise<EnqueueEmailMessageResult>,
) {
  const commands: EnqueueEmailMessageCommand[] = [];
  const notifier = createOperatorAccountCreatedNotifier({
    outbox: {
      async enqueueEmailMessage(command) {
        commands.push(command);
        if (enqueue) return enqueue(command);
        return {
          status: "enqueued",
          intentId: "00000000-0000-4000-8000-000000000010",
          deduplicated: false,
        };
      },
    },
  });
  return { commands, notifier };
}

test("an account-created notice persists only its recipient and operator-keyed intent", async () => {
  const { commands, notifier } = createHarness();
  const poisoned = {
    operatorId,
    toEmail,
    password: "must never be persisted",
    passwordHash: "hash:must never be persisted",
  };

  const result = await notifier.notifyOperatorAccountCreated(poisoned);

  assert.deepEqual(result, { status: "enqueued", deduplicated: false });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], {
    kind: "operator_account_created",
    input: { toEmail },
    recipient: toEmail,
    idempotencyKey: `operatoraccount:${operatorId}`,
    source: OPERATOR_ACCOUNT_MESSAGE_SOURCE,
  });
  assert.equal(
    commands[0]?.idempotencyKey,
    operatorAccountCreatedNoticeIdempotencyKey(operatorId),
  );
  assert.doesNotMatch(
    JSON.stringify(commands[0]),
    /must never be persisted|passwordHash|"password"/i,
  );
});

test("repeated notification converges on the same operator-only key", async () => {
  const { commands, notifier } = createHarness(async () => ({
    status: "enqueued",
    intentId: "00000000-0000-4000-8000-000000000010",
    deduplicated: true,
  }));

  assert.deepEqual(
    await notifier.notifyOperatorAccountCreated({ operatorId, toEmail }),
    { status: "enqueued", deduplicated: true },
  );
  assert.deepEqual(
    await notifier.notifyOperatorAccountCreated({
      operatorId,
      toEmail: "changed-address@packscout.test",
    }),
    { status: "enqueued", deduplicated: true },
  );
  assert.equal(commands[0]?.idempotencyKey, commands[1]?.idempotencyKey);
  assert.doesNotMatch(commands[0]?.idempotencyKey ?? "", /@|packscout/i);
});

test("outbox refusals and exceptions resolve to stable content-free failures", async () => {
  const rejected = createHarness(async () => ({
    status: "rejected",
    errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
    activeCount: 10_000,
  }));
  assert.deepEqual(
    await rejected.notifier.notifyOperatorAccountCreated({
      operatorId,
      toEmail,
    }),
    {
      status: "failed",
      reason: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
    },
  );

  const invalid = createHarness(async () => ({
    status: "invalid",
    errorCode: "EMAIL_OUTBOX_REQUEST_INVALID",
    reason: `invalid while holding secret for ${toEmail}`,
  }));
  assert.deepEqual(
    await invalid.notifier.notifyOperatorAccountCreated({ operatorId, toEmail }),
    { status: "failed", reason: "EMAIL_OUTBOX_REQUEST_INVALID" },
  );

  const throwing = createHarness(async () => {
    throw new Error(`database failed while holding secret for ${toEmail}`);
  });
  const thrown = await throwing.notifier.notifyOperatorAccountCreated({
    operatorId,
    toEmail,
  });
  assert.deepEqual(thrown, {
    status: "failed",
    reason: "EMAIL_OUTBOX_UNAVAILABLE",
  });
  assert.doesNotMatch(JSON.stringify(thrown), /@|secret|operator/i);
});
