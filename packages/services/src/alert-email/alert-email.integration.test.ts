import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PipelineSetupRepository,
  PrismaAdminNotificationPublisher,
  PrismaAlertEmailReadRepository,
  PrismaEmailMessageOutboxRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import type { OperationalLog } from "../operational-events.ts";
import { createOperationalRuntime } from "../operational-runtime.ts";
import { EmailMessageOutboxService } from "../message-outbox/outbox-service.ts";
import { AlertEmailNotificationPublisher } from "./publisher.ts";
import {
  ALERT_EMAIL_ENABLED_VARIABLE,
  ALERT_EMAIL_RECIPIENTS_VARIABLE,
  ALERT_EMAIL_WINDOW_MS_VARIABLE,
} from "./settings.ts";

const ids = {
  organization: "79000000-0000-4000-8000-000000000001",
  provider: "79000000-0000-4000-8000-000000000002",
  configuration: "79000000-0000-4000-8000-000000000003",
  run: "79000000-0000-4000-8000-000000000004",
} as const;
const start = new Date("2026-08-06T12:00:00.000Z");

test("alert email composes beside durable persistence with real flood-control state", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: ids.organization,
      slug: "alert-email-runtime",
      name: "Alert Email Runtime",
      createdAt: start,
    });
    await setup.createProviderSource({
      id: ids.provider,
      organizationId: ids.organization,
      platformKey: "fixture-provider",
      displayName: "Fixture Provider",
      createdAt: start,
    });
    await setup.createConfigRevision({
      id: ids.configuration,
      organizationId: ids.organization,
      providerId: ids.provider,
      version: 1,
      adapterKey: "fixture-mapper-v1",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "actor:test",
      createdAt: start,
    });
    await setup.createImportRun({
      id: ids.run,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      trigger: "scheduled",
      state: "failed",
      createdAt: start,
    });

    let current = start;
    const clock = { now: () => current };
    let eventSequence = 0;
    const eventIds = { id: () =>
      `79000000-0000-4000-9000-${String(++eventSequence).padStart(12, "0")}` };
    const logs: OperationalLog[] = [];
    const observability = {
      metric: () => {},
      log: (entry: OperationalLog) => void logs.push(entry),
    };
    // Routing settings are resolved per publish, so mutating this object is
    // exactly a server-side configuration change between alerts.
    const env: NodeJS.ProcessEnv = {
      [ALERT_EMAIL_RECIPIENTS_VARIABLE]: "ops@example.com",
      [ALERT_EMAIL_WINDOW_MS_VARIABLE]: "60000",
    };
    const outboxRepository = new PrismaEmailMessageOutboxRepository(
      harness.database,
    );
    const runtime = createOperationalRuntime({
      durableAdminPublisher: new PrismaAdminNotificationPublisher(
        harness.database,
      ),
      additionalPublishers: [
        new AlertEmailNotificationPublisher({
          reader: new PrismaAlertEmailReadRepository(harness.database),
          outbox: new EmailMessageOutboxService({
            queue: outboxRepository,
            clock,
          }),
          env,
          observability,
        }),
      ],
      ids: eventIds,
      clock,
      observability,
    });

    const listIntents = () =>
      harness.database.email_message_intents.findMany({
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      });
    const failRun = () =>
      runtime.events.runFailed({
        organizationId: ids.organization,
        providerId: ids.provider,
        runId: ids.run,
        failureCode: "IMPORT_TIMEOUT",
      });

    // First occurrence: durable alert plus exactly one enqueued message.
    const first = await failRun();
    assert.equal(first.status, "accepted");
    const alerts = new PrismaAdminNotificationPublisher(harness.database);
    const [summary] = await alerts.listAlerts({
      organizationId: ids.organization,
      limit: 10,
    });
    assert.ok(summary);
    assert.equal(summary.occurrenceCount, 1);
    let intents = await listIntents();
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.kind, "operational_alert");
    assert.equal(intents[0]?.recipient, "ops@example.com");
    assert.equal(intents[0]?.source, "operational_alerts");
    const firstInput = intents[0]?.input_json as unknown as {
      alertId: string;
      occurrenceCount: number;
    };
    assert.equal(firstInput.alertId, summary.id);
    assert.equal(firstInput.occurrenceCount, 1);

    // A repeat inside the window: the durable alert accumulates, no new
    // message — the enqueue converged on the existing intent.
    current = new Date(start.getTime() + 10_000);
    const second = await failRun();
    assert.equal(second.status, "deduplicated");
    intents = await listIntents();
    assert.equal(intents.length, 1);
    const [afterRepeat] = await alerts.listAlerts({
      organizationId: ids.organization,
      limit: 10,
    });
    assert.equal(afterRepeat?.occurrenceCount, 2);

    // The next occurrence after the window: one message summarizing the
    // occurrence count the durable alert accumulated.
    current = new Date(start.getTime() + 70_000);
    await failRun();
    intents = await listIntents();
    assert.equal(intents.length, 2);
    const summarizedInput = intents[1]?.input_json as unknown as {
      occurrenceCount: number;
    };
    assert.equal(summarizedInput.occurrenceCount, 3);

    // Recovery: the operators who were notified learn it recovered, keyed to
    // the alert's recovery identity.
    current = new Date(start.getTime() + 80_000);
    const recovered = await runtime.events.providerRecovered({
      organizationId: ids.organization,
      providerId: ids.provider,
    });
    assert.equal(recovered.status, "resolved");
    intents = await listIntents();
    assert.equal(intents.length, 3);
    assert.equal(intents[2]?.kind, "operational_alert_recovery");
    const recoveryInput = intents[2]?.input_json as unknown as {
      severity: string;
      occurrenceCount: number;
      alertId: string;
      recoveredAt: string;
    };
    assert.equal(recoveryInput.severity, "critical");
    assert.equal(recoveryInput.occurrenceCount, 3);
    assert.equal(recoveryInput.alertId, summary.id);
    assert.equal(recoveryInput.recoveredAt, current.toISOString());

    // The off switch restores exactly the durable-only behavior.
    env[ALERT_EMAIL_ENABLED_VARIABLE] = "0";
    current = new Date(start.getTime() + 200_000);
    const reopened = await failRun();
    assert.equal(reopened.status, "accepted");
    intents = await listIntents();
    assert.equal(intents.length, 3);
    const [reopenedSummary] = await alerts.listAlerts({
      organizationId: ids.organization,
      limit: 10,
    });
    assert.equal(reopenedSummary?.state, "active");

    // With routing on but no recipient configured, alerts persist as today
    // and the absence is visible through the operational log.
    delete env[ALERT_EMAIL_ENABLED_VARIABLE];
    env[ALERT_EMAIL_RECIPIENTS_VARIABLE] = "";
    current = new Date(start.getTime() + 300_000);
    const unconfigured = await failRun();
    assert.equal(unconfigured.status, "deduplicated");
    intents = await listIntents();
    assert.equal(intents.length, 3);
    assert.ok(
      logs.some(
        (entry) =>
          entry.level === "warning" &&
          entry.code === "ALERT_EMAIL_RECIPIENTS_UNCONFIGURED",
      ),
    );
  } finally {
    await harness.close();
  }
});
