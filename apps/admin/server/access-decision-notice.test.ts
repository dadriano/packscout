import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ProductUserAccessDecision, ProductUserRecord } from "@packscout/contracts";
import type {
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
} from "@packscout/services";
import {
  accessDecisionNoticeIdempotencyKey,
  createAccessDecisionNotifier,
  ACCESS_DECISION_MESSAGE_SOURCE,
} from "./access-decision-notice.ts";
import { ProductUserDirectoryError } from "./product-user-directory.ts";

const subject = "https://auth.example.test/|did:example:notice-1";
const subjectDigest = createHash("sha256").update(subject, "utf8").digest("hex");
const verifiedEmail = "ada@example.test";

function record(email: string | null): ProductUserRecord {
  return {
    subject,
    authMethod: "https://auth.example.test",
    email,
    walletAddress: null,
    firstSeenAt: "2026-08-01T09:00:00.000Z",
    lastSeenAt: "2026-08-19T12:00:00.000Z",
    standing: "active",
    access: {
      state: "approved",
      decidedBy: "operator",
      decidedAt: "2026-08-20T10:00:00.000Z",
    },
  };
}

function decision(
  state: ProductUserAccessDecision["state"],
  decidedAt = "2026-08-20T10:00:00.000Z",
): ProductUserAccessDecision {
  return { state, decidedBy: "operator", decidedAt };
}

function createHarness(options?: {
  readonly email?: string | null;
  readonly readRecord?: () => Promise<ProductUserRecord>;
  readonly enqueue?: (
    command: EnqueueEmailMessageCommand,
  ) => Promise<EnqueueEmailMessageResult>;
}) {
  const recordReads: { subject: string }[] = [];
  const commands: EnqueueEmailMessageCommand[] = [];
  const notifier = createAccessDecisionNotifier({
    directory: {
      async getProductUserRecord(input) {
        recordReads.push(input);
        if (options?.readRecord) return options.readRecord();
        return record(options?.email === undefined ? verifiedEmail : options.email);
      },
    },
    outbox: {
      async enqueueEmailMessage(command) {
        commands.push(command);
        if (options?.enqueue) return options.enqueue(command);
        return {
          status: "enqueued",
          intentId: `intent-${commands.length}`,
          deduplicated: false,
        };
      },
    },
  });
  return { notifier, recordReads, commands };
}

test("a genuine approval enqueues the approval message keyed to its transition", async () => {
  const { notifier, recordReads, commands } = createHarness();
  const decidedAt = "2026-08-20T10:00:00.000Z";

  const result = await notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("approved", decidedAt),
  });

  assert.deepEqual(result, { outcome: "enqueued", deduplicated: false });
  // The verified address comes from the single-record read, taken for this
  // decision alone.
  assert.deepEqual(recordReads, [{ subject }]);
  assert.equal(commands.length, 1);
  const command = commands[0]!;
  assert.equal(command.kind, "access_approved");
  assert.equal(command.recipient, verifiedEmail);
  // The outbox stores kind and rendering input; the drain renders. Both
  // access kinds take exactly the recipient address (messaging/003).
  assert.deepEqual(command.input, { toEmail: verifiedEmail });
  assert.equal(command.source, ACCESS_DECISION_MESSAGE_SOURCE);
  assert.equal(
    command.idempotencyKey,
    `accessdecision:${subjectDigest}:approved:${Date.parse(decidedAt)}`,
  );
  // The key carries a digest and closed words only — no address, no raw
  // subject — because it travels into delivery records and logs.
  assert.match(
    command.idempotencyKey,
    /^accessdecision:[0-9a-f]{64}:(approved|declined):\d+$/,
  );
  assert.doesNotMatch(command.idempotencyKey, /did:example|@|example\.test/);
});

test("a genuine decline enqueues the decline message", async () => {
  const { notifier, commands } = createHarness();

  const result = await notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("declined"),
  });

  assert.deepEqual(result, { outcome: "enqueued", deduplicated: false });
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.kind, "access_declined");
  assert.deepEqual(commands[0]!.input, { toEmail: verifiedEmail });
  assert.match(commands[0]!.idempotencyKey, /:declined:\d+$/);
});

test("a revoke announces nothing: enforcement, not an announcement", async () => {
  const { notifier, recordReads, commands } = createHarness();

  const result = await notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("awaiting_review"),
  });

  assert.deepEqual(result, { outcome: "not_applicable" });
  // Nothing is announced, so nothing about the person is even read.
  assert.deepEqual(recordReads, []);
  assert.deepEqual(commands, []);
});

test("a decision that changed nothing announces nothing", async () => {
  const { notifier, recordReads, commands } = createHarness();

  // A repeat or a concurrent operator converging on the stored decision:
  // the backend reports `changed: false` and the person was already told
  // when the decision genuinely moved.
  const result = await notifier.notifyAccessDecision({
    subject,
    changed: false,
    resulting: decision("approved"),
  });

  assert.deepEqual(result, { outcome: "not_applicable" });
  assert.deepEqual(recordReads, []);
  assert.deepEqual(commands, []);
});

test("repeats of one transition converge and re-transitions earn fresh keys", async () => {
  const { notifier, commands } = createHarness();
  const first = "2026-08-20T10:00:00.000Z";
  const again = "2026-08-21T16:30:00.000Z";

  // However often one transition is replayed, its key is deterministic, so
  // the outbox converges every enqueue on one intent.
  await notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("approved", first),
  });
  await notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("approved", first),
  });
  // A person approved, revoked, and approved again is a fresh transition
  // with a fresh decision instant, and earns a fresh message.
  await notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("approved", again),
  });

  assert.equal(commands.length, 3);
  assert.equal(commands[0]!.idempotencyKey, commands[1]!.idempotencyKey);
  assert.notEqual(commands[0]!.idempotencyKey, commands[2]!.idempotencyKey);
  assert.equal(
    commands[2]!.idempotencyKey,
    accessDecisionNoticeIdempotencyKey(subject, "approved", Date.parse(again)),
  );
});

test("an identity with no verified address is a normal skip, never an error", async () => {
  const missing = createHarness({ email: null });
  const missingResult = await missing.notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("approved"),
  });
  assert.deepEqual(missingResult, { outcome: "skipped_no_verified_email" });
  assert.deepEqual(missing.commands, []);

  // An address the outbox bound would refuse is the same permanent skip,
  // not a failure to retry against a validation that will not change.
  const unusable = createHarness({ email: "not-an-address" });
  const unusableResult = await unusable.notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("declined"),
  });
  assert.deepEqual(unusableResult, { outcome: "skipped_no_verified_email" });
  assert.deepEqual(unusable.commands, []);
});

test("a failed record read is a bounded failure code, never a thrown error", async () => {
  const refused = createHarness({
    readRecord: async () => {
      throw new ProductUserDirectoryError(
        "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
        "The product-user directory is temporarily unavailable.",
        503,
      );
    },
  });
  assert.deepEqual(
    await refused.notifier.notifyAccessDecision({
      subject,
      changed: true,
      resulting: decision("approved"),
    }),
    { outcome: "failed", reason: "PRODUCT_USER_DIRECTORY_UNAVAILABLE" },
  );
  assert.deepEqual(refused.commands, []);

  // An unexpected throw carries who knows what; only the bounded code
  // survives it.
  const broken = createHarness({
    readRecord: async () => {
      throw new Error(`upstream 500 for ${subject} <${verifiedEmail}>`);
    },
  });
  const result = await broken.notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: decision("approved"),
  });
  assert.deepEqual(result, {
    outcome: "failed",
    reason: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
  });
  assert.doesNotMatch(JSON.stringify(result), /did:example|@|example\.test/);
});

test("outbox refusals and throws are bounded failure codes", async () => {
  const rejected = createHarness({
    enqueue: async () => ({
      status: "rejected",
      errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
      activeCount: 10_000,
    }),
  });
  assert.deepEqual(
    await rejected.notifier.notifyAccessDecision({
      subject,
      changed: true,
      resulting: decision("approved"),
    }),
    { outcome: "failed", reason: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED" },
  );

  const invalid = createHarness({
    enqueue: async () => ({
      status: "invalid",
      errorCode: "EMAIL_OUTBOX_REQUEST_INVALID",
      reason: "The recipient is not a valid bounded email address.",
    }),
  });
  assert.deepEqual(
    await invalid.notifier.notifyAccessDecision({
      subject,
      changed: true,
      resulting: decision("approved"),
    }),
    { outcome: "failed", reason: "EMAIL_OUTBOX_REQUEST_INVALID" },
  );

  const throwing = createHarness({
    enqueue: async () => {
      throw new Error(`database exploded while holding ${verifiedEmail}`);
    },
  });
  assert.deepEqual(
    await throwing.notifier.notifyAccessDecision({
      subject,
      changed: true,
      resulting: decision("declined"),
    }),
    { outcome: "failed", reason: "EMAIL_OUTBOX_UNAVAILABLE" },
  );
});

test("an already-recorded transition reports the convergence honestly", async () => {
  const { notifier } = createHarness({
    enqueue: async () => ({
      status: "enqueued",
      intentId: "intent-existing",
      deduplicated: true,
    }),
  });
  assert.deepEqual(
    await notifier.notifyAccessDecision({
      subject,
      changed: true,
      resulting: decision("approved"),
    }),
    { outcome: "enqueued", deduplicated: true },
  );
});

test("a transition without a readable instant fails closed without inventing a key", async () => {
  const { notifier, commands } = createHarness();
  const result = await notifier.notifyAccessDecision({
    subject,
    changed: true,
    resulting: { state: "approved", decidedBy: "operator", decidedAt: "not-a-date" },
  });
  assert.deepEqual(result, {
    outcome: "failed",
    reason: "ACCESS_DECISION_TRANSITION_INVALID",
  });
  assert.deepEqual(commands, []);
});
