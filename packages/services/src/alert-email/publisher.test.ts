import assert from "node:assert/strict";
import { test } from "node:test";
import {
  operationalEventKindSchema,
  type NotificationPublishResult,
  type OperationalNotification,
} from "@packscout/contracts";
import {
  CompositeNotificationPublisher,
  type NotificationPublisher,
  type OperationalLog,
} from "../operational-events.ts";
import type {
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
} from "../message-outbox/outbox-service.ts";
import {
  ALERT_EMAIL_OUTBOX_SOURCE,
  ALERT_EMAIL_RECOVERY_EVENT_KINDS,
  AlertEmailNotificationPublisher,
  type AlertEmailAlertState,
  type AlertEmailResolvedAlertState,
  type AlertEmailStateReader,
} from "./publisher.ts";
import {
  ALERT_EMAIL_RECIPIENTS_VARIABLE,
  ALERT_EMAIL_SEVERITIES_VARIABLE,
  ALERT_EMAIL_WINDOW_MS_VARIABLE,
  ALERT_EMAIL_ENABLED_VARIABLE,
} from "./settings.ts";

const organizationId = "77000000-0000-4000-8000-000000000001";
const providerId = "77000000-0000-4000-8000-000000000002";
const alertId = "77000000-0000-4000-8000-0000000000aa";
const secondAlertId = "77000000-0000-4000-8000-0000000000ab";
const firstSeenAt = new Date("2026-08-06T09:00:00.000Z");

let eventSequence = 0;

function alertEvent(
  overrides: Partial<OperationalNotification> = {},
): OperationalNotification {
  return {
    id: `77000000-0000-4000-9000-${String(++eventSequence).padStart(12, "0")}`,
    organizationId,
    kind: "run_failed",
    severity: "critical",
    providerId,
    runId: null,
    quarantineId: null,
    dedupeKey: `provider:run-failed:${providerId}`,
    recoveryKey: `provider:health:${providerId}`,
    title: "Provider import failed",
    summary: "The provider import stopped with a sanitized failure code.",
    evidence: { failureCode: "IMPORT_TIMEOUT" },
    occurredAt: "2026-08-06T12:00:00.000Z",
    ...overrides,
  };
}

function recoveryEvent(
  overrides: Partial<OperationalNotification> = {},
): OperationalNotification {
  return alertEvent({
    kind: "provider_recovered",
    severity: "info",
    dedupeKey: `provider:recovered:${providerId}`,
    title: "Provider recovered",
    summary: "The provider reached its configured health target.",
    evidence: { outcome: "PROVIDER_RECOVERED" },
    ...overrides,
  });
}

class FakeReader implements AlertEmailStateReader {
  alert: AlertEmailAlertState | null = {
    alertId,
    occurrenceCount: 1,
    firstSeenAt,
  };
  resolvedAlerts: readonly AlertEmailResolvedAlertState[] = [];
  findCalls = 0;
  listCalls: Array<{ recoveryKey: string; eventId: string }> = [];
  failFind = false;

  findAlertByDedupeKey(): Promise<AlertEmailAlertState | null> {
    this.findCalls += 1;
    if (this.failFind) return Promise.reject(new Error("read outage"));
    return Promise.resolve(this.alert);
  }

  listAlertsResolvedByEvent(input: {
    recoveryKey: string;
    eventId: string;
  }): Promise<readonly AlertEmailResolvedAlertState[]> {
    this.listCalls.push({
      recoveryKey: input.recoveryKey,
      eventId: input.eventId,
    });
    return Promise.resolve(this.resolvedAlerts);
  }
}

class RecordingOutbox {
  readonly commands: EnqueueEmailMessageCommand[] = [];
  nextResult: EnqueueEmailMessageResult | "throw" = {
    status: "enqueued",
    intentId: "77000000-0000-4000-8000-0000000000ff",
    deduplicated: false,
  };

  enqueueEmailMessage(
    command: EnqueueEmailMessageCommand,
  ): Promise<EnqueueEmailMessageResult> {
    this.commands.push(command);
    if (this.nextResult === "throw") {
      return Promise.reject(new Error("enqueue outage"));
    }
    return Promise.resolve(this.nextResult);
  }
}

function harness(env: NodeJS.ProcessEnv = {}) {
  const reader = new FakeReader();
  const outbox = new RecordingOutbox();
  const logs: OperationalLog[] = [];
  const publisher = new AlertEmailNotificationPublisher({
    reader,
    outbox,
    env: {
      [ALERT_EMAIL_RECIPIENTS_VARIABLE]: "ops@example.com",
      ...env,
    },
    observability: { metric: () => {}, log: (entry) => logs.push(entry) },
  });
  return { reader, outbox, logs, publisher };
}

test("recovery kind classification mirrors the contract's vocabulary", () => {
  // The durable alert path resolves rather than raises for exactly these
  // kinds. A new kind must land in one bucket deliberately.
  const expected = operationalEventKindSchema.options.filter(
    (kind) => kind.endsWith("_recovered") || kind === "quarantine_resolved",
  );
  assert.deepEqual([...ALERT_EMAIL_RECOVERY_EVENT_KINDS].sort(), expected.sort());
  assert.deepEqual(
    [...ALERT_EMAIL_RECOVERY_EVENT_KINDS].sort(),
    [
      "machinery_recovered",
      "promotion_recovered",
      "provider_recovered",
      "quarantine_resolved",
      "retention_recovered",
    ],
  );
});

test("configured severities enqueue one message per recipient; info stays admin-only", async () => {
  const { outbox, publisher } = harness({
    [ALERT_EMAIL_RECIPIENTS_VARIABLE]: "ops@example.com,lead@example.com",
  });
  await publisher.publish(alertEvent({ severity: "critical" }));
  await publisher.publish(
    alertEvent({
      kind: "provider_stale",
      severity: "warning",
      dedupeKey: `provider:stale:${providerId}`,
      evidence: { durationMs: 901_000 },
    }),
  );
  // No raising kind is informational today, so exercise the severity gate
  // directly with an info-severity raising event.
  await publisher.publish(alertEvent({ severity: "info" }));
  assert.equal(outbox.commands.length, 4);
  assert.deepEqual(
    outbox.commands.map((command) => command.kind),
    Array(4).fill("operational_alert"),
  );
  assert.deepEqual(
    outbox.commands.map((command) => command.recipient),
    [
      "ops@example.com",
      "lead@example.com",
      "ops@example.com",
      "lead@example.com",
    ],
  );
  assert.ok(
    outbox.commands.every(
      (command) => command.source === ALERT_EMAIL_OUTBOX_SOURCE,
    ),
  );
});

test("severity routing is configurable server-side", async () => {
  const { outbox, publisher } = harness({
    [ALERT_EMAIL_SEVERITIES_VARIABLE]: "critical",
  });
  await publisher.publish(
    alertEvent({
      kind: "provider_stale",
      severity: "warning",
      dedupeKey: `provider:stale:${providerId}`,
      evidence: { durationMs: 901_000 },
    }),
  );
  assert.equal(outbox.commands.length, 0);
  await publisher.publish(alertEvent());
  assert.equal(outbox.commands.length, 1);
});

test("repeat occurrences inside the window converge on one idempotency key", async () => {
  const { reader, outbox, publisher } = harness({
    [ALERT_EMAIL_WINDOW_MS_VARIABLE]: "3600000",
  });
  await publisher.publish(alertEvent({ occurredAt: "2026-08-06T12:00:00.000Z" }));
  reader.alert = { alertId, occurrenceCount: 2, firstSeenAt };
  outbox.nextResult = {
    status: "enqueued",
    intentId: "77000000-0000-4000-8000-0000000000ff",
    deduplicated: true,
  };
  await publisher.publish(alertEvent({ occurredAt: "2026-08-06T12:31:00.000Z" }));
  reader.alert = { alertId, occurrenceCount: 3, firstSeenAt };
  await publisher.publish(alertEvent({ occurredAt: "2026-08-06T12:59:59.000Z" }));
  assert.equal(outbox.commands.length, 3);
  const keys = new Set(outbox.commands.map((command) => command.idempotencyKey));
  // Identical keys are the flood control: the durable outbox converges them
  // onto the intent that already exists, so no new message is produced.
  assert.equal(keys.size, 1);
  const [key] = keys;
  assert.match(key ?? "", /^opsalert:77000000-0000-4000-8000-0000000000aa:w3600000:b\d+:r[0-9a-f]{16}$/);
});

test("the first occurrence past the window summarizes the accumulated count", async () => {
  const { reader, outbox, publisher } = harness({
    [ALERT_EMAIL_WINDOW_MS_VARIABLE]: "3600000",
  });
  await publisher.publish(alertEvent({ occurredAt: "2026-08-06T12:00:00.000Z" }));
  reader.alert = { alertId, occurrenceCount: 41, firstSeenAt };
  await publisher.publish(alertEvent({ occurredAt: "2026-08-06T13:10:00.000Z" }));
  assert.equal(outbox.commands.length, 2);
  const [first, second] = outbox.commands;
  assert.notEqual(first?.idempotencyKey, second?.idempotencyKey);
  const summarized = second?.input as { occurrenceCount: number };
  assert.equal(summarized.occurrenceCount, 41);
});

test("message content carries only the alert's safe title, summary, and codes", async () => {
  const { outbox, publisher } = harness();
  await publisher.publish(
    alertEvent({
      evidence: {
        failureCode: "IMPORT_TIMEOUT",
        reasonCode: "RETRY_BUDGET_SPENT",
        durationMs: 5_000,
        count: 3,
      },
    }),
  );
  assert.equal(outbox.commands.length, 1);
  assert.deepEqual(outbox.commands[0]?.input, {
    toEmail: "ops@example.com",
    severity: "critical",
    title: "Provider import failed",
    summary: "The provider import stopped with a sanitized failure code.",
    evidenceCodes: ["IMPORT_TIMEOUT", "RETRY_BUDGET_SPENT"],
    occurrenceCount: 1,
    firstSeenAt: firstSeenAt.toISOString(),
    alertId,
  });
});

test("recovery notices reach recipients for alerts this event resolved at notified severities", async () => {
  const { reader, outbox, publisher } = harness({
    [ALERT_EMAIL_RECIPIENTS_VARIABLE]: "ops@example.com,lead@example.com",
  });
  reader.resolvedAlerts = [
    {
      alertId,
      occurrenceCount: 42,
      firstSeenAt,
      raisedSeverity: "critical",
    },
    // Raised informational: its operators were never emailed, so recovery
    // is not emailed either.
    {
      alertId: secondAlertId,
      occurrenceCount: 5,
      firstSeenAt,
      raisedSeverity: "info",
    },
  ];
  const event = recoveryEvent();
  await publisher.publish(event);
  assert.deepEqual(reader.listCalls, [
    { recoveryKey: event.recoveryKey, eventId: event.id },
  ]);
  assert.equal(outbox.commands.length, 2);
  for (const command of outbox.commands) {
    assert.equal(command.kind, "operational_alert_recovery");
    assert.match(
      command.idempotencyKey,
      new RegExp(`^opsrecovery:${alertId}:${event.id}:r[0-9a-f]{16}$`),
    );
    assert.deepEqual(command.input, {
      toEmail: command.recipient,
      severity: "critical",
      title: "Provider recovered",
      summary: "The provider reached its configured health target.",
      evidenceCodes: ["PROVIDER_RECOVERED"],
      // The resolving event incremented the durable count; the notice
      // reports occurrences while the alert was active.
      occurrenceCount: 41,
      firstSeenAt: firstSeenAt.toISOString(),
      alertId,
      recoveredAt: event.occurredAt,
    });
  }
});

test("a recovery that resolved nothing notifies nobody", async () => {
  const { reader, outbox, publisher } = harness();
  reader.resolvedAlerts = [];
  await publisher.publish(recoveryEvent());
  assert.equal(outbox.commands.length, 0);
});

test("no recipient configured: nothing enqueues and the absence is visible", async () => {
  const { reader, outbox, logs, publisher } = harness({
    [ALERT_EMAIL_RECIPIENTS_VARIABLE]: "",
  });
  const result = await publisher.publish(alertEvent());
  assert.deepEqual(result, {
    status: "accepted",
    alertId: null,
    failureCode: null,
  });
  assert.equal(outbox.commands.length, 0);
  assert.deepEqual(
    logs.map((entry) => [entry.level, entry.code, entry.event]),
    [["warning", "ALERT_EMAIL_RECIPIENTS_UNCONFIGURED", "notification"]],
  );
  // Recovery of a notified-severity alert reports the same absence.
  reader.resolvedAlerts = [
    { alertId, occurrenceCount: 3, firstSeenAt, raisedSeverity: "critical" },
  ];
  await publisher.publish(recoveryEvent());
  assert.equal(outbox.commands.length, 0);
  assert.equal(
    logs.filter((entry) => entry.code === "ALERT_EMAIL_RECIPIENTS_UNCONFIGURED")
      .length,
    2,
  );
});

test("the off switch restores exactly the durable-only behavior", async () => {
  const { reader, outbox, logs, publisher } = harness({
    [ALERT_EMAIL_ENABLED_VARIABLE]: "0",
  });
  const result = await publisher.publish(alertEvent());
  await publisher.publish(recoveryEvent());
  assert.deepEqual(result, {
    status: "accepted",
    alertId: null,
    failureCode: null,
  });
  assert.equal(reader.findCalls, 0);
  assert.equal(reader.listCalls.length, 0);
  assert.equal(outbox.commands.length, 0);
  assert.deepEqual(logs, []);
});

test("email trouble never changes the composite outcome for producers", async () => {
  const durableResult: NotificationPublishResult = {
    status: "accepted",
    alertId,
    failureCode: null,
  };
  const durable: NotificationPublisher = {
    publish: () => Promise.resolve(durableResult),
  };
  for (const breakage of ["reader", "enqueue-throw", "enqueue-reject"] as const) {
    const { reader, outbox, logs, publisher } = harness();
    if (breakage === "reader") reader.failFind = true;
    if (breakage === "enqueue-throw") outbox.nextResult = "throw";
    if (breakage === "enqueue-reject") {
      outbox.nextResult = {
        status: "rejected",
        errorCode: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
        activeCount: 10_000,
      };
    }
    const composite = new CompositeNotificationPublisher([durable, publisher]);
    const result = await composite.publish(alertEvent());
    assert.deepEqual(result, durableResult, breakage);
    assert.ok(
      logs.every((entry) => entry.code.startsWith("ALERT_EMAIL_")),
      breakage,
    );
    assert.equal(logs.length, 1, breakage);
  }
});

test("a missing durable alert row is reported and produces no message", async () => {
  const { reader, outbox, logs, publisher } = harness();
  reader.alert = null;
  const result = await publisher.publish(alertEvent());
  assert.deepEqual(result, {
    status: "accepted",
    alertId: null,
    failureCode: null,
  });
  assert.equal(outbox.commands.length, 0);
  assert.deepEqual(
    logs.map((entry) => entry.code),
    ["ALERT_EMAIL_ALERT_STATE_MISSING"],
  );
});

test("an observability sink that throws never breaks publishing", async () => {
  const reader = new FakeReader();
  reader.failFind = true;
  const publisher = new AlertEmailNotificationPublisher({
    reader,
    outbox: new RecordingOutbox(),
    env: { [ALERT_EMAIL_RECIPIENTS_VARIABLE]: "ops@example.com" },
    observability: {
      metric: () => {},
      log: () => {
        throw new Error("sink outage");
      },
    },
  });
  const result = await publisher.publish(alertEvent());
  assert.equal(result.status, "accepted");
});
