import { createHash } from "node:crypto";
import {
  operationalEventKindSchema,
  type NotificationPublishResult,
  type OperationalEventKind,
  type OperationalNotification,
  type OperationalSeverity,
} from "@packscout/contracts";
import type {
  NotificationPublisher,
  OperationalObservability,
} from "../operational-events.ts";
import type {
  OperationalAlertMessageInput,
  OperationalAlertRecoveryMessageInput,
} from "../message-catalogue/catalogue.ts";
import type {
  EnqueueEmailMessageCommand,
  EnqueueEmailMessageResult,
} from "../message-outbox/outbox-service.ts";
import {
  resolveAlertEmailRoutingSettings,
  type AlertEmailRoutingSettings,
} from "./settings.ts";

/**
 * Routes operational alerts to operator email as one more publisher on the
 * existing notification boundary. It composes beside the durable admin
 * publisher — never instead of it — and its result is deliberately inert: it
 * always resolves with a non-failed status, so the composite's outcome for
 * producers is exactly the durable publisher's whatever happens here. No
 * alert producer changes, and pipeline work never waits on email delivery,
 * because this publisher only enqueues durable message intents.
 *
 * Flood control reads the alert layer's own state rather than keeping a
 * parallel one. The durable publisher runs first in the composite, so by the
 * time this publisher sees an event the admin alert row already carries the
 * occurrence count, first-seen time, and identity for this occurrence. The
 * outbox idempotency key is derived from that alert identity plus the
 * notification window bucket, so every repeat occurrence inside one window
 * converges on the message that already exists, and the first occurrence in
 * the next window sends one message summarizing the accumulated count.
 */

/** The triggering source the outbox's per-source volume bound applies to. */
export const ALERT_EMAIL_OUTBOX_SOURCE = "operational_alerts";

/** The catalogue kinds this publisher enqueues. */
export const ALERT_EMAIL_MESSAGE_KIND = "operational_alert";
export const ALERT_EMAIL_RECOVERY_MESSAGE_KIND = "operational_alert_recovery";

/**
 * The event kinds the durable alert path treats as recoveries: they resolve
 * alerts by recovery key instead of raising one. The durable repository keeps
 * its classification private, so this mirrors it; the membership test pins
 * the two sets together through the contract's kind vocabulary.
 */
export const ALERT_EMAIL_RECOVERY_EVENT_KINDS: ReadonlySet<OperationalEventKind> =
  new Set(
    operationalEventKindSchema.options.filter(
      (kind) => kind.endsWith("_recovered") || kind === "quarantine_resolved",
    ),
  );

/** One recovery event resolves at most a handful of alerts sharing its key;
 * the read and the enqueue fan-out stay bounded regardless. */
const RESOLVED_ALERTS_PER_RECOVERY_LIMIT = 10;

/** The durable alert state one raising occurrence resolves to. */
export interface AlertEmailAlertState {
  readonly alertId: string;
  readonly occurrenceCount: number;
  readonly firstSeenAt: Date;
}

/** A resolved alert plus the severity it was last raised at. */
export interface AlertEmailResolvedAlertState extends AlertEmailAlertState {
  /** Null when no raising occurrence is on record for the alert. */
  readonly raisedSeverity: OperationalSeverity | null;
}

/**
 * Read access to the durable alert state the flood-control and recovery
 * decisions are made from. Implemented over the admin alert tables; this
 * publisher never keeps its own notification state.
 */
export interface AlertEmailStateReader {
  findAlertByDedupeKey(input: {
    readonly organizationId: string;
    readonly dedupeKey: string;
  }): Promise<AlertEmailAlertState | null>;
  listAlertsResolvedByEvent(input: {
    readonly organizationId: string;
    readonly recoveryKey: string;
    readonly eventId: string;
    readonly limit: number;
  }): Promise<readonly AlertEmailResolvedAlertState[]>;
}

/** The enqueue side of the durable outbox (messaging/004); never delivery. */
export interface AlertEmailMessageEnqueuer {
  enqueueEmailMessage(
    command: EnqueueEmailMessageCommand,
  ): Promise<EnqueueEmailMessageResult>;
}

export interface AlertEmailNotificationPublisherOptions {
  readonly reader: AlertEmailStateReader;
  readonly outbox: AlertEmailMessageEnqueuer;
  /** Routing settings are resolved from here on every publish. */
  readonly env?: NodeJS.ProcessEnv;
  readonly observability?: OperationalObservability;
}

/**
 * Every publish resolves to this. Routing problems are reported through
 * observability instead, so email trouble can never look like an alert
 * persistence failure to a producer.
 */
const INERT_RESULT: NotificationPublishResult = Object.freeze({
  status: "accepted",
  alertId: null,
  failureCode: null,
});

/** Recipient identity inside an idempotency key: the raw address may carry
 * characters outside the key alphabet, so a short stable digest stands in. */
function recipientDigest(recipient: string): string {
  return createHash("sha256")
    .update(recipient.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

/** Only the evidence fields that are stable codes; measures and identifiers
 * stay in the admin where the message links to. */
function evidenceCodes(
  evidence: OperationalNotification["evidence"],
): readonly string[] {
  return [evidence.failureCode, evidence.reasonCode, evidence.outcome].filter(
    (code): code is string => code !== undefined,
  );
}

export class AlertEmailNotificationPublisher implements NotificationPublisher {
  readonly #reader: AlertEmailStateReader;
  readonly #outbox: AlertEmailMessageEnqueuer;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #observability: OperationalObservability | undefined;

  constructor(options: AlertEmailNotificationPublisherOptions) {
    this.#reader = options.reader;
    this.#outbox = options.outbox;
    this.#env = options.env;
    this.#observability = options.observability;
  }

  /** Never rejects and never reports failure; see {@link INERT_RESULT}. */
  async publish(
    event: OperationalNotification,
  ): Promise<NotificationPublishResult> {
    try {
      await this.route(event);
    } catch {
      this.report(event, "error", "ALERT_EMAIL_ROUTING_FAILED");
    }
    return INERT_RESULT;
  }

  private async route(event: OperationalNotification): Promise<void> {
    const settings = resolveAlertEmailRoutingSettings(this.#env);
    // The off switch restores exactly the durable-only behavior: no reads,
    // no enqueues, and no routing observability at all.
    if (!settings.enabled) return;
    for (const problem of settings.problems) {
      this.report(event, "warning", problem);
    }
    if (ALERT_EMAIL_RECOVERY_EVENT_KINDS.has(event.kind)) {
      await this.routeRecovery(event, settings);
      return;
    }
    if (!settings.severities.has(event.severity)) return;
    const alert = await this.#reader.findAlertByDedupeKey({
      organizationId: event.organizationId,
      dedupeKey: event.dedupeKey,
    });
    if (alert === null) {
      // Durable persistence is authoritative; without its row there is no
      // occurrence count and nothing in the admin to link to.
      this.report(event, "warning", "ALERT_EMAIL_ALERT_STATE_MISSING");
      return;
    }
    if (!this.hasRecipients(event, settings)) return;
    // Same alert, same window, same recipient => same key: the outbox
    // converges every repeat inside the window onto the existing intent.
    const bucket = Math.floor(Date.parse(event.occurredAt) / settings.windowMs);
    const input: Omit<OperationalAlertMessageInput, "toEmail"> = {
      severity: event.severity,
      title: event.title,
      summary: event.summary,
      evidenceCodes: evidenceCodes(event.evidence),
      occurrenceCount: alert.occurrenceCount,
      firstSeenAt: alert.firstSeenAt.toISOString(),
      alertId: alert.alertId,
    };
    for (const recipient of settings.recipients) {
      await this.enqueue(event, {
        kind: ALERT_EMAIL_MESSAGE_KIND,
        input: { toEmail: recipient, ...input },
        recipient,
        idempotencyKey: `opsalert:${alert.alertId}:w${settings.windowMs}:b${bucket}:r${recipientDigest(recipient)}`,
        source: ALERT_EMAIL_OUTBOX_SOURCE,
      });
    }
  }

  /**
   * A recovery event resolves alerts by its recovery key; the durable
   * publisher has already done so when this runs. Notices go out only for
   * alerts this very event resolved, and only when the alert's last raised
   * severity is one the routing configuration notifies about — the operators
   * who were told it broke are the ones told it recovered, and an alert that
   * never produced email produces no recovery either. The recovery event's
   * own severity (always informational) plays no part.
   */
  private async routeRecovery(
    event: OperationalNotification,
    settings: AlertEmailRoutingSettings,
  ): Promise<void> {
    const resolved = await this.#reader.listAlertsResolvedByEvent({
      organizationId: event.organizationId,
      recoveryKey: event.recoveryKey,
      eventId: event.id,
      limit: RESOLVED_ALERTS_PER_RECOVERY_LIMIT,
    });
    const notifiable = resolved.filter(
      (
        alert,
      ): alert is AlertEmailResolvedAlertState & {
        readonly raisedSeverity: OperationalSeverity;
      } =>
        alert.raisedSeverity !== null &&
        settings.severities.has(alert.raisedSeverity),
    );
    if (notifiable.length === 0) return;
    if (!this.hasRecipients(event, settings)) return;
    for (const alert of notifiable) {
      const input: Omit<OperationalAlertRecoveryMessageInput, "toEmail"> = {
        severity: alert.raisedSeverity,
        title: event.title,
        summary: event.summary,
        evidenceCodes: evidenceCodes(event.evidence),
        // The resolving event also incremented the row's occurrence count;
        // the notice reports occurrences while the alert was active.
        occurrenceCount: Math.max(1, alert.occurrenceCount - 1),
        firstSeenAt: alert.firstSeenAt.toISOString(),
        alertId: alert.alertId,
        recoveredAt: event.occurredAt,
      };
      for (const recipient of settings.recipients) {
        await this.enqueue(event, {
          kind: ALERT_EMAIL_RECOVERY_MESSAGE_KIND,
          input: { toEmail: recipient, ...input },
          recipient,
          // One resolving event, one notice per alert and recipient; a later
          // recovery cycle carries a new event identity and notifies again.
          idempotencyKey: `opsrecovery:${alert.alertId}:${event.id}:r${recipientDigest(recipient)}`,
          source: ALERT_EMAIL_OUTBOX_SOURCE,
        });
      }
    }
  }

  /** No recipient configured is a visible condition, never a silent one. */
  private hasRecipients(
    event: OperationalNotification,
    settings: AlertEmailRoutingSettings,
  ): boolean {
    if (settings.recipients.length > 0) return true;
    this.report(event, "warning", "ALERT_EMAIL_RECIPIENTS_UNCONFIGURED");
    return false;
  }

  private async enqueue(
    event: OperationalNotification,
    command: EnqueueEmailMessageCommand,
  ): Promise<void> {
    let result: EnqueueEmailMessageResult;
    try {
      result = await this.#outbox.enqueueEmailMessage(command);
    } catch {
      this.report(event, "warning", "ALERT_EMAIL_ENQUEUE_FAILED");
      return;
    }
    if (result.status === "rejected") {
      this.report(event, "warning", "ALERT_EMAIL_ENQUEUE_REJECTED");
    } else if (result.status === "invalid") {
      this.report(event, "warning", "ALERT_EMAIL_ENQUEUE_INVALID");
    }
  }

  private report(
    event: OperationalNotification,
    level: "info" | "warning" | "error",
    code: string,
  ): void {
    try {
      this.#observability?.log({
        event: "notification",
        level,
        organizationId: event.organizationId,
        providerId: event.providerId,
        code,
        occurredAt: event.occurredAt,
      });
    } catch {
      // Observability stays best-effort; routing never depends on it.
    }
  }
}
