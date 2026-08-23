import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
} from "../message-outbox/outbox-service.ts";
import type {
  ClaimedWelcome,
  WelcomeDispatchDirectoryPort,
  WelcomeSettleOutcome,
} from "./directory-client.ts";
import {
  WelcomeDispatchService,
  welcomeIdempotencyKey,
  WELCOME_MESSAGE_KIND,
  WELCOME_MESSAGE_SOURCE,
} from "./dispatch-service.ts";

const ALICE = "privy.io|did:privy:alice";

interface SettleCall {
  readonly subject: string;
  readonly outcome: WelcomeSettleOutcome;
}

function fakeDirectory(batches: ClaimedWelcome[][]) {
  const claimCalls: { limit: number; leaseMilliseconds: number }[] = [];
  const settleCalls: SettleCall[] = [];
  let failSettles = false;
  let batch = 0;
  const port: WelcomeDispatchDirectoryPort = {
    async claimDueWelcomes(input) {
      claimCalls.push(input);
      const claims = batches[batch] ?? [];
      batch += 1;
      return claims;
    },
    async settleWelcome(input) {
      if (failSettles) throw new Error("settle transport down");
      settleCalls.push(input);
      return "settled";
    },
  };
  return {
    port,
    claimCalls,
    settleCalls,
    failSettles() {
      failSettles = true;
    },
  };
}

function fakeOutbox(
  respond: (command: EnqueueEmailMessageCommand) => EnqueueEmailMessageResult,
) {
  const commands: EnqueueEmailMessageCommand[] = [];
  return {
    commands,
    outbox: {
      async enqueueEmailMessage(command: EnqueueEmailMessageCommand) {
        commands.push(command);
        return respond(command);
      },
    },
  };
}

function enqueuedResult(deduplicated: boolean): EnqueueEmailMessageResult {
  return {
    status: "enqueued",
    intentId: "11111111-1111-4111-8111-111111111111",
    deduplicated,
  };
}

function service(
  directory: WelcomeDispatchDirectoryPort,
  outbox: { enqueueEmailMessage(c: EnqueueEmailMessageCommand): Promise<EnqueueEmailMessageResult> },
  options?: { batchSize?: number; leaseMilliseconds?: number },
) {
  return new WelcomeDispatchService({
    directory,
    outbox,
    options: {
      batchSize: options?.batchSize ?? 10,
      leaseMilliseconds: options?.leaseMilliseconds ?? 300_000,
    },
  });
}

test("a pass claims, enqueues one welcome per identity, and settles only after the durable enqueue", async () => {
  const directory = fakeDirectory([
    [{ subject: ALICE, email: "alice@example.com" }],
  ]);
  const { commands, outbox } = fakeOutbox(() => enqueuedResult(false));

  const result = await service(directory.port, outbox, {
    batchSize: 5,
    leaseMilliseconds: 60_000,
  }).runCycle();

  assert.deepEqual(result, {
    outcome: "dispatched",
    claimed: 1,
    enqueued: 1,
    deduplicated: 0,
    skipped: 0,
    errors: 0,
    capReached: false,
  });
  assert.deepEqual(directory.claimCalls, [
    { limit: 5, leaseMilliseconds: 60_000 },
  ]);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], {
    kind: WELCOME_MESSAGE_KIND,
    input: { toEmail: "alice@example.com" },
    recipient: "alice@example.com",
    idempotencyKey: welcomeIdempotencyKey(ALICE),
    source: WELCOME_MESSAGE_SOURCE,
  });
  assert.deepEqual(directory.settleCalls, [
    { subject: ALICE, outcome: "sent" },
  ]);
});

test("the idempotency key is deterministic per identity, bounded, and carries no raw subject", () => {
  const key = welcomeIdempotencyKey(ALICE);
  assert.equal(key, welcomeIdempotencyKey(ALICE));
  assert.notEqual(key, welcomeIdempotencyKey("privy.io|did:privy:bob"));
  assert.match(key, /^welcome:[0-9a-f]{64}$/);
  assert.equal(key.includes("privy"), false);
  // The outbox key alphabet and bound, exactly.
  assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/);
});

test("a crash between claim and enqueue converges on one message: the retry pass deduplicates and settles", async () => {
  // Pass one claimed and crashed before enqueueing (modeled by the claim
  // simply lapsing); pass two rediscovers the identity and enqueues into
  // the outbox, which reports the intent already existed if pass one had
  // gotten its enqueue through. Either way the recipient gets one message.
  const directory = fakeDirectory([
    [{ subject: ALICE, email: "alice@example.com" }],
  ]);
  const { commands, outbox } = fakeOutbox(() => enqueuedResult(true));

  const result = await service(directory.port, outbox).runCycle();

  assert.deepEqual(result, {
    outcome: "dispatched",
    claimed: 1,
    enqueued: 1,
    deduplicated: 1,
    skipped: 0,
    errors: 0,
    capReached: false,
  });
  // The retry used the identical key, which is what converged the intents.
  assert.equal(commands[0]?.idempotencyKey, welcomeIdempotencyKey(ALICE));
  assert.deepEqual(directory.settleCalls, [
    { subject: ALICE, outcome: "sent" },
  ]);
});

test("an identity with no usable address settles as the recorded skip and never reaches the outbox", async () => {
  const directory = fakeDirectory([
    [
      { subject: ALICE, email: null },
      { subject: "privy.io|did:privy:bob", email: "not-an-address" },
    ],
  ]);
  const { commands, outbox } = fakeOutbox(() => enqueuedResult(false));

  const result = await service(directory.port, outbox).runCycle();

  assert.equal(result.skipped, 2);
  assert.equal(result.enqueued, 0);
  assert.equal(commands.length, 0);
  assert.deepEqual(directory.settleCalls, [
    { subject: ALICE, outcome: "no_verified_email" },
    { subject: "privy.io|did:privy:bob", outcome: "no_verified_email" },
  ]);
});

test("a refused enqueue leaves the claim unsettled to lapse and retry — never a silent skip", async () => {
  const directory = fakeDirectory([
    [{ subject: ALICE, email: "alice@example.com" }],
  ]);
  const { outbox } = fakeOutbox(() => ({
    status: "rejected",
    errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
    activeCount: 10_000,
  }));

  const result = await service(directory.port, outbox).runCycle();

  assert.equal(result.errors, 1);
  assert.equal(result.enqueued, 0);
  assert.equal(result.skipped, 0);
  // No settle happened: the marker stays claimed and lapses back to due.
  assert.deepEqual(directory.settleCalls, []);
});

test("a settlement failure after a durable enqueue is contained; the lapse-and-retry path resolves it", async () => {
  const directory = fakeDirectory([
    [{ subject: ALICE, email: "alice@example.com" }],
  ]);
  directory.failSettles();
  const { commands, outbox } = fakeOutbox(() => enqueuedResult(false));

  const result = await service(directory.port, outbox).runCycle();

  // The message is durably enqueued; only the marker settlement is owed.
  assert.equal(commands.length, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.enqueued, 0);
});

test("one poisoned identity cannot stop the rest of the pass", async () => {
  const directory = fakeDirectory([
    [
      { subject: "privy.io|did:privy:poison", email: "poison@example.com" },
      { subject: ALICE, email: "alice@example.com" },
    ],
  ]);
  const { outbox } = fakeOutbox((command) => {
    if (command.recipient === "poison@example.com") {
      throw new Error("storage failure");
    }
    return enqueuedResult(false);
  });

  const result = await service(directory.port, outbox).runCycle();

  assert.equal(result.claimed, 2);
  assert.equal(result.errors, 1);
  assert.equal(result.enqueued, 1);
  assert.deepEqual(directory.settleCalls, [
    { subject: ALICE, outcome: "sent" },
  ]);
});

test("passes are bounded and report a full batch so the caller can run again promptly", async () => {
  const claims: ClaimedWelcome[] = [0, 1].map((index) => ({
    subject: `privy.io|did:privy:user-${index}`,
    email: `user-${index}@example.com`,
  }));
  const directory = fakeDirectory([claims]);
  const { outbox } = fakeOutbox(() => enqueuedResult(false));

  const result = await service(directory.port, outbox, {
    batchSize: 2,
    leaseMilliseconds: 60_000,
  }).runCycle();

  assert.equal(result.claimed, 2);
  assert.equal(result.capReached, true);
});

test("option bounds are refused at construction", () => {
  const directory = fakeDirectory([]);
  const { outbox } = fakeOutbox(() => enqueuedResult(false));
  for (const options of [
    { batchSize: 0, leaseMilliseconds: 60_000 },
    { batchSize: 21, leaseMilliseconds: 60_000 },
    { batchSize: 5, leaseMilliseconds: 999 },
    { batchSize: 5, leaseMilliseconds: 900_001 },
  ]) {
    assert.throws(
      () =>
        new WelcomeDispatchService({
          directory: directory.port,
          outbox,
          options,
        }),
      RangeError,
    );
  }
});
