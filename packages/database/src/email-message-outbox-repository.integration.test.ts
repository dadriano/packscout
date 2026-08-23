import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrismaEmailMessageOutboxRepository,
  enqueueEmailMessageIntent,
  type EnqueueEmailMessageIntentResult,
} from "./email-message-outbox-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const enqueuedAt = new Date("2026-08-22T12:00:00.000Z");

function enqueueInput(overrides: {
  idempotencyKey: string;
  recipient?: string;
  source?: string;
  kind?: string;
  dueAt?: Date;
  sourceActiveLimit?: number;
  input?: unknown;
}) {
  return {
    kind: overrides.kind ?? "welcome",
    input: overrides.input ?? { locale: "en" },
    recipient: overrides.recipient ?? "person@example.test",
    idempotencyKey: overrides.idempotencyKey,
    source: overrides.source ?? "closed_beta",
    dueAt: overrides.dueAt ?? enqueuedAt,
    now: enqueuedAt,
    sourceActiveLimit: overrides.sourceActiveLimit ?? 1_000,
  };
}

function enqueuedId(result: EnqueueEmailMessageIntentResult): string {
  assert.equal(result.status, "enqueued");
  return result.status === "enqueued" ? result.intentId : "";
}

test("an enqueued intent survives its writer's shutdown and is claimable afterwards", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    // The writer is a full client lifecycle: its startup readiness check also
    // proves the outbox migration is one the platform expects.
    const writer = harness.createClientLifecycle();
    await writer.start();
    const enqueued = await new PrismaEmailMessageOutboxRepository(
      writer.client,
    ).enqueue(
      enqueueInput({
        idempotencyKey: "welcome:user-1",
        input: { plan: "beta" },
      }),
    );
    const intentId = enqueuedId(enqueued);
    await writer.close();

    // A different connection — the process that restarted — claims it.
    const drain = new PrismaEmailMessageOutboxRepository(
      await harness.createIndependentClient(),
    );
    const claims = await drain.claimDueBatch({
      workerId: "worker:restarted:1",
      now: new Date(enqueuedAt.getTime() + 1_000),
      limit: 10,
      perRecipientLimit: 10,
      leaseMilliseconds: 60_000,
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.intentId, intentId);
    assert.equal(claims[0]?.kind, "welcome");
    assert.equal(claims[0]?.recipient, "person@example.test");
    assert.deepEqual(claims[0]?.input, { plan: "beta" });
    assert.equal(claims[0]?.attemptNumber, 1);
  } finally {
    await harness.close();
  }
});

test("enqueueing composes into a caller's transaction: rollback leaves nothing, commit records it", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const transactionInput = {
      kind: "operator_password_reset",
      recipient: "operator@example.test",
      idempotencyKey: "reset:token-1",
      source: "operator_accounts",
      serializedInput: JSON.stringify({ resetLinkPath: "/reset/opaque" }),
      dueAt: enqueuedAt,
      now: enqueuedAt,
      sourceActiveLimit: 100,
    };
    // The caller's own work fails after the enqueue: nothing may remain —
    // an intent that was not recorded is not half-sent.
    await assert.rejects(
      harness.database.$transaction(async (transaction) => {
        const result = await enqueueEmailMessageIntent(
          transaction,
          transactionInput,
        );
        assert.equal(result.status, "enqueued");
        throw new Error("caller work failed after the enqueue");
      }),
      /caller work failed/,
    );
    assert.equal(await harness.database.email_message_intents.count(), 0);

    // The caller's work succeeds: the intent lands in the same commit.
    const committed = await harness.database.$transaction((transaction) =>
      enqueueEmailMessageIntent(transaction, transactionInput),
    );
    assert.equal(committed.status, "enqueued");
    assert.equal(await harness.database.email_message_intents.count(), 1);
  } finally {
    await harness.close();
  }
});

test("duplicate enqueues converge on one intent, concurrently and minutes apart", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const first = new PrismaEmailMessageOutboxRepository(harness.database);
    const second = new PrismaEmailMessageOutboxRepository(
      await harness.createIndependentClient(),
    );
    const key = "access:decision:user-9";
    const [left, right] = await Promise.all([
      first.enqueue(enqueueInput({ idempotencyKey: key })),
      second.enqueue(enqueueInput({ idempotencyKey: key })),
    ]);
    const leftId = enqueuedId(left);
    const rightId = enqueuedId(right);
    assert.equal(leftId, rightId);
    assert.equal(
      [left, right].filter(
        (result) => result.status === "enqueued" && !result.deduplicated,
      ).length,
      1,
      "exactly one of the concurrent enqueues created the intent",
    );

    const later = await first.enqueue(enqueueInput({ idempotencyKey: key }));
    assert.deepEqual(later, {
      status: "enqueued",
      intentId: leftId,
      deduplicated: true,
    });
    assert.equal(await harness.database.email_message_intents.count(), 1);
  } finally {
    await harness.close();
  }
});

test("two concurrent drains claim disjoint intents and an active lease blocks reclaim", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    for (let index = 0; index < 8; index += 1) {
      await repository.enqueue(
        enqueueInput({
          idempotencyKey: `alert:${index}`,
          recipient: `operator-${index}@example.test`,
        }),
      );
    }
    const other = new PrismaEmailMessageOutboxRepository(
      await harness.createIndependentClient(),
    );
    const claimAt = new Date(enqueuedAt.getTime() + 1_000);
    const [alpha, beta] = await Promise.all([
      repository.claimDueBatch({
        workerId: "worker:alpha",
        now: claimAt,
        limit: 8,
        perRecipientLimit: 8,
        leaseMilliseconds: 60_000,
      }),
      other.claimDueBatch({
        workerId: "worker:beta",
        now: claimAt,
        limit: 8,
        perRecipientLimit: 8,
        leaseMilliseconds: 60_000,
      }),
    ]);
    const alphaIds = new Set(alpha.map((claim) => claim.intentId));
    for (const claim of beta) {
      assert.equal(alphaIds.has(claim.intentId), false, "claims overlap");
    }
    assert.equal(alpha.length + beta.length, 8);

    // While every lease is live, nothing is claimable.
    assert.deepEqual(
      await repository.claimDueBatch({
        workerId: "worker:gamma",
        now: new Date(claimAt.getTime() + 1_000),
        limit: 8,
        perRecipientLimit: 8,
        leaseMilliseconds: 60_000,
      }),
      [],
    );

    // Past the lease, a claim is reclaimable under a fresh token, and the
    // stale claimant's outcome write is lost rather than applied twice.
    const stale = [...alpha, ...beta][0];
    assert.ok(stale);
    const reclaimAt = new Date(claimAt.getTime() + 61_000);
    const reclaimed = await repository.claimDueBatch({
      workerId: "worker:gamma",
      now: reclaimAt,
      limit: 8,
      perRecipientLimit: 8,
      leaseMilliseconds: 60_000,
    });
    assert.equal(reclaimed.length, 8);
    const fresh = reclaimed.find((claim) => claim.intentId === stale.intentId);
    assert.ok(fresh);
    assert.notEqual(fresh.claimToken, stale.claimToken);
    assert.equal(fresh.attemptNumber, 2);

    assert.equal(
      await repository.recordAttemptOutcome({
        intentId: stale.intentId,
        claimToken: stale.claimToken,
        attemptNumber: stale.attemptNumber,
        occurredAt: new Date(reclaimAt.getTime() + 1_000),
        outcome: {
          status: "sent",
          provider: "postmark",
          providerMessageId: "stale-write",
        },
      }),
      "lost",
    );
    assert.equal(
      await harness.database.email_message_attempts.count({
        where: { intent_id: stale.intentId },
      }),
      0,
      "a lost claim records no attempt",
    );
  } finally {
    await harness.close();
  }
});

test("retryable failures back off to the limit then rest failed; non-retryable failures rest at once", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const intentId = enqueuedId(
      await repository.enqueue(enqueueInput({ idempotencyKey: "retryable:1" })),
    );
    const maximumAttempts = 3;
    let now = new Date(enqueuedAt.getTime() + 1_000);
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const [claim] = await repository.claimDueBatch({
        workerId: "worker:alpha",
        now,
        limit: 5,
        perRecipientLimit: 5,
        leaseMilliseconds: 30_000,
      });
      assert.ok(claim, `attempt ${attempt} was claimable`);
      assert.equal(claim.attemptNumber, attempt);
      const retryAt = new Date(now.getTime() + 60_000 * attempt);
      const outcome = await repository.recordAttemptOutcome({
        intentId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: now,
        outcome: {
          status: "failed",
          provider: "postmark",
          errorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
          errorMessage: "Provider connection reset.",
          retryable: true,
          retryAt,
          maximumAttempts,
        },
      });
      const record = await repository.getIntent(intentId);
      if (attempt < maximumAttempts) {
        assert.equal(outcome, "retrying");
        assert.equal(record?.state, "retrying");
        assert.deepEqual(record?.dueAt, retryAt);
        assert.equal(record?.finalizedAt, null);
        // Not due again before its backoff instant.
        assert.deepEqual(
          await repository.claimDueBatch({
            workerId: "worker:alpha",
            now: new Date(retryAt.getTime() - 1),
            limit: 5,
            perRecipientLimit: 5,
            leaseMilliseconds: 30_000,
          }),
          [],
        );
        now = new Date(retryAt.getTime() + 1_000);
      } else {
        assert.equal(outcome, "failed");
        assert.equal(record?.state, "failed");
        assert.notEqual(record?.finalizedAt, null);
        assert.equal(record?.lastErrorCode, "EMAIL_POSTMARK_TRANSPORT_FAILED");
      }
    }
    // Terminal failure is never claimed again.
    assert.deepEqual(
      await repository.claimDueBatch({
        workerId: "worker:alpha",
        now: new Date(now.getTime() + 86_400_000),
        limit: 5,
        perRecipientLimit: 5,
        leaseMilliseconds: 30_000,
      }),
      [],
    );
    const attempts = await repository.listAttempts(intentId);
    assert.deepEqual(
      attempts.map((attempt) => attempt.attemptNumber),
      [1, 2, 3],
    );

    // A non-retryable failure — a rendering failure or rejected recipient —
    // rests terminally on its first outcome.
    const terminalId = enqueuedId(
      await repository.enqueue(enqueueInput({ idempotencyKey: "terminal:1" })),
    );
    const [claim] = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now: new Date(now.getTime() + 90_000_000),
      limit: 5,
      perRecipientLimit: 5,
      leaseMilliseconds: 30_000,
    });
    assert.equal(claim?.intentId, terminalId);
    assert.equal(
      await repository.recordAttemptOutcome({
        intentId: terminalId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: new Date(now.getTime() + 90_000_000),
        outcome: {
          status: "failed",
          provider: null,
          errorCode: "EMAIL_MESSAGE_INPUT_INVALID",
          errorMessage: "The stored rendering input is invalid.",
          retryable: false,
          retryAt: new Date(now.getTime() + 90_060_000),
          maximumAttempts,
        },
      }),
      "failed",
    );
    const terminal = await repository.getIntent(terminalId);
    assert.equal(terminal?.state, "failed");
    assert.equal(terminal?.attemptCount, 1);
  } finally {
    await harness.close();
  }
});

test("skipped outcomes rest as skipped with their reason, never as failures", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const intentId = enqueuedId(
      await repository.enqueue(enqueueInput({ idempotencyKey: "skip:1" })),
    );
    const now = new Date(enqueuedAt.getTime() + 1_000);
    const [claim] = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now,
      limit: 5,
      perRecipientLimit: 5,
      leaseMilliseconds: 30_000,
    });
    assert.ok(claim);
    assert.equal(
      await repository.recordAttemptOutcome({
        intentId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: now,
        outcome: { status: "skipped", provider: null, reason: "console_mode" },
      }),
      "skipped",
    );
    const record = await repository.getIntent(intentId);
    assert.equal(record?.state, "skipped");
    assert.equal(record?.lastSkipReason, "console_mode");
    assert.equal(record?.lastErrorCode, null);
    const counts = await repository.countIntents({ now });
    assert.equal(counts.skipped, 1);
    assert.equal(counts.failed, 0);
  } finally {
    await harness.close();
  }
});

test("attempt records carry the outcome facts and no message body", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const intentId = enqueuedId(
      await repository.enqueue(enqueueInput({ idempotencyKey: "facts:1" })),
    );
    const now = new Date(enqueuedAt.getTime() + 1_000);
    const [claim] = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now,
      limit: 5,
      perRecipientLimit: 5,
      leaseMilliseconds: 30_000,
    });
    assert.ok(claim);
    await repository.recordAttemptOutcome({
      intentId,
      claimToken: claim.claimToken,
      attemptNumber: claim.attemptNumber,
      occurredAt: now,
      outcome: {
        status: "sent",
        provider: "postmark",
        providerMessageId: "pm-message-42",
      },
    });
    const [attempt] = await repository.listAttempts(intentId);
    assert.deepEqual(attempt, {
      id: attempt?.id,
      intentId,
      attemptNumber: 1,
      attemptedAt: now,
      outcome: "sent",
      provider: "postmark",
      providerMessageId: "pm-message-42",
      errorCode: null,
      errorMessage: null,
      errorRetryable: null,
      skipReason: null,
    });
    // The attempt table has no column that could carry a rendered body,
    // subject, or credential — only bounded outcome facts.
    const columns = await harness.database.$queryRawUnsafe<
      Array<{ column_name: string }>
    >(
      `select column_name from information_schema.columns
       where table_name = 'email_message_attempts' order by column_name`,
    );
    assert.deepEqual(
      columns.map((column) => column.column_name),
      [
        "attempt_number",
        "attempted_at",
        "error_code",
        "error_message",
        "error_retryable",
        "id",
        "intent_id",
        "outcome",
        "provider",
        "provider_message_id",
        "skip_reason",
      ],
    );
  } finally {
    await harness.close();
  }
});

test("queue counts are answerable in one indexed aggregate", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const later = new Date(enqueuedAt.getTime() + 3_600_000);
    // Two pending-and-due, one pending-but-not-yet-due, one retrying, one
    // sent, one failed terminal, one claimed under a live lease.
    for (const key of ["count:a", "count:b", "count:claimed"]) {
      await repository.enqueue(
        enqueueInput({ idempotencyKey: key, recipient: `${key.replace(":", "-")}@example.test` }),
      );
    }
    await repository.enqueue(
      enqueueInput({
        idempotencyKey: "count:future",
        dueAt: new Date(later.getTime() + 86_400_000),
      }),
    );
    for (const [key, terminal] of [
      ["count:retrying", false],
      ["count:sent", false],
      ["count:failed", true],
    ] as const) {
      await repository.enqueue(
        enqueueInput({ idempotencyKey: key, recipient: `${key.replace(":", "-")}@example.test` }),
      );
      void terminal;
    }
    const now = new Date(enqueuedAt.getTime() + 1_000);
    const claims = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now,
      limit: 6,
      perRecipientLimit: 6,
      leaseMilliseconds: 600_000,
    });
    for (const claim of claims) {
      const byKey = await harness.database.email_message_intents.findUnique({
        where: { id: claim.intentId },
        select: { idempotency_key: true },
      });
      if (byKey?.idempotency_key === "count:retrying") {
        await repository.recordAttemptOutcome({
          intentId: claim.intentId,
          claimToken: claim.claimToken,
          attemptNumber: claim.attemptNumber,
          occurredAt: now,
          outcome: {
            status: "failed",
            provider: "postmark",
            errorCode: "EMAIL_DELIVERY_TIMEOUT",
            errorMessage: "",
            retryable: true,
            retryAt: new Date(later.getTime() + 60_000),
            maximumAttempts: 5,
          },
        });
      } else if (byKey?.idempotency_key === "count:sent") {
        await repository.recordAttemptOutcome({
          intentId: claim.intentId,
          claimToken: claim.claimToken,
          attemptNumber: claim.attemptNumber,
          occurredAt: now,
          outcome: { status: "sent", provider: "postmark", providerMessageId: null },
        });
      } else if (byKey?.idempotency_key === "count:failed") {
        await repository.recordAttemptOutcome({
          intentId: claim.intentId,
          claimToken: claim.claimToken,
          attemptNumber: claim.attemptNumber,
          occurredAt: now,
          outcome: {
            status: "failed",
            provider: "postmark",
            errorCode: "EMAIL_POSTMARK_ERROR_406",
            errorMessage: "Recipient rejected.",
            retryable: false,
            retryAt: new Date(later.getTime() + 60_000),
            maximumAttempts: 5,
          },
        });
      } else if (byKey?.idempotency_key !== "count:claimed") {
        // Release the two plain pending rows back by letting their lease lapse
        // in the assertions below; nothing to do here.
      }
    }

    // While the leases are live: the three unfinished claims stay in the
    // pending state but are counted as claimed, and nothing is due.
    const whileClaimed = await repository.countIntents({
      now: new Date(now.getTime() + 1_000),
    });
    assert.equal(whileClaimed.pending, 4);
    assert.equal(whileClaimed.retrying, 1);
    assert.equal(whileClaimed.claimed, 3);
    assert.equal(whileClaimed.due, 0);
    assert.equal(whileClaimed.failed, 1);
    assert.equal(whileClaimed.sent, 1);

    const countsAt = new Date(later.getTime() + 7_200_000);
    harness.statementCounter.reset();
    const counts = await repository.countIntents({ now: countsAt });
    assert.equal(harness.statementCounter.count, 1, "counts run one statement");
    // Leases from `now` have lapsed by `countsAt`, so the three unfinished
    // claims (count:a, count:b, count:claimed) are pending and due again; the
    // retrying row is due once its backoff instant passes.
    assert.equal(counts.pending, 4);
    assert.equal(counts.retrying, 1);
    assert.equal(counts.claimed, 0);
    assert.equal(counts.due, 4);
    assert.equal(counts.failed, 1);
    assert.equal(counts.sent, 1);
    assert.equal(counts.skipped, 0);
    assert.deepEqual(counts.oldestDueAt, enqueuedAt);
  } finally {
    await harness.close();
  }
});

test("one recipient's backlog cannot monopolize a claim pass", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    for (let index = 0; index < 10; index += 1) {
      await repository.enqueue(
        enqueueInput({
          idempotencyKey: `flood:${index}`,
          recipient: "flooded@example.test",
          dueAt: new Date(enqueuedAt.getTime() + index),
        }),
      );
    }
    for (const other of ["quiet-one", "quiet-two", "quiet-three"]) {
      await repository.enqueue(
        enqueueInput({
          idempotencyKey: `calm:${other}`,
          recipient: `${other}@example.test`,
          // Later than every flooded message: only fairness can include them.
          dueAt: new Date(enqueuedAt.getTime() + 60_000),
        }),
      );
    }
    const claims = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now: new Date(enqueuedAt.getTime() + 120_000),
      limit: 5,
      perRecipientLimit: 2,
      leaseMilliseconds: 30_000,
    });
    assert.equal(claims.length, 5);
    const flooded = claims.filter(
      (claim) => claim.recipient === "flooded@example.test",
    );
    assert.equal(flooded.length, 2, "the flooded recipient is capped");
    assert.equal(
      new Set(claims.map((claim) => claim.recipient)).size,
      4,
      "every quiet recipient is served in the same pass",
    );
  } finally {
    await harness.close();
  }
});

test("per-source enqueue volume is bounded and capacity frees on terminal outcomes", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const limited = { source: "operational_alerts", sourceActiveLimit: 2 };
    // Distinct due instants keep the later single-claim deterministic.
    const first = await repository.enqueue(
      enqueueInput({ idempotencyKey: "bound:1", ...limited, dueAt: enqueuedAt }),
    );
    await repository.enqueue(
      enqueueInput({
        idempotencyKey: "bound:2",
        ...limited,
        dueAt: new Date(enqueuedAt.getTime() + 1),
      }),
    );
    const rejected = await repository.enqueue(
      enqueueInput({ idempotencyKey: "bound:3", ...limited }),
    );
    assert.deepEqual(rejected, {
      status: "rejected",
      errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
      activeCount: 2,
    });
    // A repeat of an already-queued event still converges instead of counting
    // against capacity, and another source is unaffected.
    assert.deepEqual(
      await repository.enqueue(enqueueInput({ idempotencyKey: "bound:1", ...limited })),
      { status: "enqueued", intentId: enqueuedId(first), deduplicated: true },
    );
    assert.equal(
      (
        await repository.enqueue(
          enqueueInput({
            idempotencyKey: "bound:other",
            source: "closed_beta",
            dueAt: new Date(enqueuedAt.getTime() + 2),
          }),
        )
      ).status,
      "enqueued",
    );

    // Delivering one frees capacity for the source.
    const now = new Date(enqueuedAt.getTime() + 1_000);
    const [claim] = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now,
      limit: 1,
      perRecipientLimit: 1,
      leaseMilliseconds: 30_000,
    });
    assert.ok(claim);
    await repository.recordAttemptOutcome({
      intentId: claim.intentId,
      claimToken: claim.claimToken,
      attemptNumber: claim.attemptNumber,
      occurredAt: now,
      outcome: { status: "sent", provider: "postmark", providerMessageId: null },
    });
    assert.equal(
      (await repository.enqueue(enqueueInput({ idempotencyKey: "bound:3", ...limited })))
        .status,
      "enqueued",
    );
  } finally {
    await harness.close();
  }
});

test("pruning ages out only terminal history and never a live intent", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const now = new Date(enqueuedAt.getTime() + 1_000);
    const finished: string[] = [];
    for (const key of ["prune:sent", "prune:failed"]) {
      const intentId = enqueuedId(
        await repository.enqueue(
          enqueueInput({ idempotencyKey: key, recipient: `${key.replace(":", "-")}@example.test` }),
        ),
      );
      finished.push(intentId);
    }
    const liveId = enqueuedId(
      await repository.enqueue(
        enqueueInput({ idempotencyKey: "prune:live", recipient: "live@example.test" }),
      ),
    );
    const claims = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now,
      limit: 3,
      perRecipientLimit: 3,
      leaseMilliseconds: 30_000,
    });
    for (const claim of claims) {
      if (claim.intentId === liveId) continue;
      await repository.recordAttemptOutcome({
        intentId: claim.intentId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: now,
        outcome:
          claim.intentId === finished[0]
            ? { status: "sent", provider: "postmark", providerMessageId: "x" }
            : {
                status: "failed",
                provider: "postmark",
                errorCode: "EMAIL_POSTMARK_ERROR_406",
                errorMessage: "Recipient rejected.",
                retryable: false,
                retryAt: new Date(now.getTime() + 60_000),
                maximumAttempts: 5,
              },
      });
    }

    // A cutoff far past every record: only the live intent may survive. The
    // live intent is older than the cutoff too — its state protects it.
    const cutoff = new Date(now.getTime() + 86_400_000);
    assert.equal(
      await repository.pruneHistory({ cutoffAt: cutoff, limit: 1 }),
      1,
      "pruning is bounded per call",
    );
    assert.equal(await repository.pruneHistory({ cutoffAt: cutoff, limit: 10 }), 1);
    assert.equal(await repository.pruneHistory({ cutoffAt: cutoff, limit: 10 }), 0);
    assert.equal(await harness.database.email_message_attempts.count(), 0);
    const survivors = await harness.database.email_message_intents.findMany({
      select: { id: true },
    });
    assert.deepEqual(
      survivors.map((row) => row.id),
      [liveId],
    );
  } finally {
    await harness.close();
  }
});

test("the read model lists newest-first with filters and bounded pages", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(
        enqueuedId(
          await repository.enqueue(
            enqueueInput({
              idempotencyKey: `list:${index}`,
              kind: index % 2 === 0 ? "welcome" : "access_approved",
              recipient: `reader-${index % 2}@example.test`,
            }),
          ),
        ),
      );
    }
    const page = await repository.listIntents({ limit: 3 });
    assert.equal(page.items.length, 3);
    assert.equal(page.hasMore, true);
    const rest = await repository.listIntents({
      limit: 3,
      before: {
        createdAt: page.items[2]!.createdAt,
        id: page.items[2]!.id,
      },
    });
    assert.equal(rest.items.length, 1);
    assert.equal(rest.hasMore, false);
    assert.equal(
      new Set([...page.items, ...rest.items].map((item) => item.id)).size,
      4,
    );

    const welcomes = await repository.listIntents({ limit: 10, kind: "welcome" });
    assert.equal(welcomes.items.length, 2);
    const byRecipient = await repository.listIntents({
      limit: 10,
      recipient: "reader-1@example.test",
    });
    assert.equal(byRecipient.items.length, 2);
    const pending = await repository.listIntents({ limit: 10, state: "pending" });
    assert.equal(pending.items.length, 4);
    assert.equal(await repository.getIntent(ids[0]!).then((row) => row?.id), ids[0]);
  } finally {
    await harness.close();
  }
});

test("an operator requeue re-enters a terminal failure into the normal queue, bounded and history-preserving", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const intentId = enqueuedId(
      await repository.enqueue(enqueueInput({ idempotencyKey: "requeue:1" })),
    );
    const failedAt = new Date(enqueuedAt.getTime() + 1_000);
    const [claim] = await repository.claimDueBatch({
      workerId: "worker:alpha",
      now: failedAt,
      limit: 5,
      perRecipientLimit: 5,
      leaseMilliseconds: 30_000,
    });
    assert.ok(claim);
    assert.equal(
      await repository.recordAttemptOutcome({
        intentId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: failedAt,
        outcome: {
          status: "failed",
          provider: "postmark",
          errorCode: "EMAIL_POSTMARK_REJECTED",
          errorMessage: "The provider rejected the message.",
          retryable: false,
          retryAt: new Date(failedAt.getTime() + 60_000),
          maximumAttempts: 2,
        },
      }),
      "failed",
    );

    // The retry: failed becomes pending, due immediately, with the attempt
    // counter and history preserved and the last failure still readable.
    const requeuedAt = new Date(failedAt.getTime() + 3_600_000);
    const requeued = await repository.requeueTerminalIntent({
      intentId,
      now: requeuedAt,
    });
    assert.equal(requeued?.state, "pending");
    assert.deepEqual(requeued?.dueAt, requeuedAt);
    assert.equal(requeued?.attemptCount, 1);
    assert.equal(requeued?.finalizedAt, null);
    assert.equal(requeued?.claimedBy, null);
    assert.equal(requeued?.lastErrorCode, "EMAIL_POSTMARK_REJECTED");
    assert.equal(requeued?.lastAttemptedAt?.getTime(), failedAt.getTime());
    assert.deepEqual(
      (await repository.listAttempts(intentId)).map(
        (attempt) => attempt.attemptNumber,
      ),
      [1],
    );

    // The ordinary drain — not anything inline — picks it up again.
    const [reclaim] = await repository.claimDueBatch({
      workerId: "worker:beta",
      now: requeuedAt,
      limit: 5,
      perRecipientLimit: 5,
      leaseMilliseconds: 30_000,
    });
    assert.equal(reclaim?.intentId, intentId);
    assert.equal(reclaim?.attemptNumber, 2);

    // Bounded: the preserved counter means one more failure at the attempt
    // limit rests the intent terminally failed again, not back on a ladder.
    assert.equal(
      await repository.recordAttemptOutcome({
        intentId,
        claimToken: reclaim.claimToken,
        attemptNumber: reclaim.attemptNumber,
        occurredAt: requeuedAt,
        outcome: {
          status: "failed",
          provider: "postmark",
          errorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
          errorMessage: "Provider connection reset.",
          retryable: true,
          retryAt: new Date(requeuedAt.getTime() + 60_000),
          maximumAttempts: 2,
        },
      }),
      "failed",
    );
    assert.equal((await repository.getIntent(intentId))?.state, "failed");
  } finally {
    await harness.close();
  }
});

test("requeueing refuses every non-terminal-failed state and concurrent requeues converge on one", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const now = new Date(enqueuedAt.getTime() + 1_000);

    async function settle(
      idempotencyKey: string,
      outcome: "sent" | "skipped" | "failed",
    ): Promise<string> {
      const intentId = enqueuedId(
        await repository.enqueue(enqueueInput({ idempotencyKey })),
      );
      const claims = await repository.claimDueBatch({
        workerId: "worker:alpha",
        now,
        limit: 5,
        perRecipientLimit: 5,
        leaseMilliseconds: 30_000,
      });
      const claim = claims.find((candidate) => candidate.intentId === intentId);
      assert.ok(claim, `${idempotencyKey} was claimable`);
      await repository.recordAttemptOutcome({
        intentId,
        claimToken: claim.claimToken,
        attemptNumber: claim.attemptNumber,
        occurredAt: now,
        outcome:
          outcome === "sent"
            ? { status: "sent", provider: "postmark", providerMessageId: "pm-1" }
            : outcome === "skipped"
              ? { status: "skipped", provider: null, reason: "delivery_disabled" }
              : {
                  status: "failed",
                  provider: "postmark",
                  errorCode: "EMAIL_POSTMARK_REJECTED",
                  errorMessage: "Rejected.",
                  retryable: false,
                  retryAt: new Date(now.getTime() + 60_000),
                  maximumAttempts: 2,
                },
      });
      return intentId;
    }

    // Live and terminal-but-delivered states all refuse: only `failed` moves.
    const pendingId = enqueuedId(
      await repository.enqueue(
        enqueueInput({
          idempotencyKey: "requeue:pending",
          recipient: "pending@example.test",
          dueAt: new Date(now.getTime() + 86_400_000),
        }),
      ),
    );
    const sentId = await settle("requeue:sent", "sent");
    const skippedId = await settle("requeue:skipped", "skipped");
    for (const refusedId of [pendingId, sentId, skippedId]) {
      assert.equal(
        await repository.requeueTerminalIntent({ intentId: refusedId, now }),
        null,
      );
    }
    assert.equal((await repository.getIntent(pendingId))?.state, "pending");
    assert.equal((await repository.getIntent(sentId))?.state, "sent");
    assert.equal((await repository.getIntent(skippedId))?.state, "skipped");

    // Concurrent retries of the same failed intent converge on exactly one
    // requeue: the guarded single UPDATE lets one through and the rest see a
    // live intent.
    const failedId = await settle("requeue:failed", "failed");
    const requeuedAt = new Date(now.getTime() + 120_000);
    const outcomes = await Promise.all([
      repository.requeueTerminalIntent({ intentId: failedId, now: requeuedAt }),
      repository.requeueTerminalIntent({ intentId: failedId, now: requeuedAt }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome !== null).length, 1);
    const converged = await repository.getIntent(failedId);
    assert.equal(converged?.state, "pending");
    assert.equal(converged?.attemptCount, 1);

    // An unknown intent refuses the same way rather than erroring.
    assert.equal(
      await repository.requeueTerminalIntent({
        intentId: "00000000-0000-4000-8000-00000000dead",
        now,
      }),
      null,
    );
  } finally {
    await harness.close();
  }
});

test("a concurrent duplicate converges instead of being refused for backlog", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const repository = new PrismaEmailMessageOutboxRepository(harness.database);
    const limited = { source: "operational_alerts", sourceActiveLimit: 2 };
    await repository.enqueue(
      enqueueInput({ idempotencyKey: "race:seed", ...limited, dueAt: enqueuedAt }),
    );
    // One slot left, and two callers enqueue the SAME triggering event at once.
    // Both miss the pre-transaction fast path; the advisory lock serializes
    // them, and the first fills the last slot. The second must still recognise
    // its own event rather than be told the backlog is full — its intent
    // demonstrably exists.
    const [a, b] = await Promise.all([
      repository.enqueue(
        enqueueInput({ idempotencyKey: "race:same", ...limited, dueAt: enqueuedAt }),
      ),
      repository.enqueue(
        enqueueInput({ idempotencyKey: "race:same", ...limited, dueAt: enqueuedAt }),
      ),
    ]);
    const outcomes = [a, b];
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "enqueued").length,
      2,
      "both callers must be told their event is queued",
    );
    assert.equal(
      outcomes.filter(
        (outcome) => outcome.status === "enqueued" && outcome.deduplicated,
      ).length,
      1,
      "exactly one of them converged on the other's intent",
    );
    const ids = new Set(
      outcomes.map((outcome) =>
        outcome.status === "enqueued" ? outcome.intentId : null,
      ),
    );
    assert.equal(ids.size, 1, "both must name the same intent");
    // Capacity is genuinely spent now, so a different event is still refused.
    assert.equal(
      (
        await repository.enqueue(
          enqueueInput({ idempotencyKey: "race:other", ...limited }),
        )
      ).status,
      "rejected",
    );
  } finally {
    await harness.close();
  }
});
