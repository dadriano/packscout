/**
 * Turns the machinery conditions into operational alerts on a bounded cadence.
 *
 * The service owns no thresholds and makes no judgements: a facts source hands
 * it the conditions the shared evaluations already decided, plus the machinery
 * alerts currently open, and it publishes through the existing operational
 * event path so storage, grouping, acknowledgement, and resolution stay exactly
 * as they are for every other alert.
 *
 * A condition is published once per episode, not once per cycle: while an alert
 * for the same recovery key is still open, the condition is already being
 * reported and re-publishing it would only append another permanent
 * `operational_events` row for a situation an operator can already see. A
 * condition that stops holding is closed once — only alerts that are actually
 * open are cleared — and a recurrence publishes again through the same
 * lifecycle.
 *
 * A cycle is best-effort per workspace but never silently: one unreadable
 * tenant is counted, skipped, and reported to the observer so the rest keep
 * their alerting, while a failure that leaves *no* workspace evaluated rejects,
 * because that is machinery alerting being disabled rather than degraded.
 */

import type {
  MachineryCondition,
  MachineryConditionKind,
} from "@packscout/contracts";
import type { OperationalEventService } from "./operational-events.ts";

export interface OpenMachineryAlert {
  readonly kind: MachineryConditionKind;
  readonly recoveryKey: string;
  readonly providerId: string | null;
  readonly runId: string | null;
}

export interface MachineryAlertFacts {
  readonly conditions: readonly MachineryCondition[];
  /** Machinery alerts that are still active or acknowledged for a workspace. */
  readonly openAlerts: readonly OpenMachineryAlert[];
}

export interface MachineryAlertFactsSource {
  /** Workspaces to evaluate, already bounded by the composition. */
  listOrganizations(): Promise<readonly string[]>;
  readFacts(organizationId: string): Promise<MachineryAlertFacts>;
}

export interface MachineryAlertCycleResult {
  readonly organizations: number;
  readonly raised: number;
  readonly cleared: number;
  readonly failedOrganizations: number;
  readonly failedPublications: number;
}

export interface MachineryAlertObserver {
  cycleCompleted(result: MachineryAlertCycleResult): void;
  /**
   * One workspace could not be evaluated while others still were. Optional so a
   * caller that only watches completed cycles keeps compiling, but a production
   * composition must supply it: without it a facts repository that is broken for
   * some tenants degrades their alerting with nothing said about it.
   */
  organizationFailed?(event: {
    readonly organizationId: string;
    readonly error: unknown;
  }): void;
}

/**
 * A cycle that evaluated nothing at all. Alerting is disabled, not degraded, so
 * it is raised to the caller's failure path rather than reported as a quiet
 * cycle that found no conditions.
 */
export class MachineryAlertCycleError extends Error {
  readonly code = "MACHINERY_ALERT_CYCLE_UNREADABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MachineryAlertCycleError";
  }
}

type PublicationCounts = { raised: number; cleared: number; failed: number };

export class MachineryAlertService {
  constructor(
    private readonly source: MachineryAlertFactsSource,
    private readonly events: Pick<
      OperationalEventService,
      "machineryConditionRaised" | "machineryConditionCleared"
    >,
    private readonly observer?: MachineryAlertObserver,
  ) {}

  async runCycle(): Promise<MachineryAlertCycleResult> {
    let organizations: readonly string[];
    try {
      organizations = await this.source.listOrganizations();
    } catch (error) {
      // Reporting this as a successful cycle over zero workspaces is how a
      // broken facts repository disables every machinery alert without anybody
      // noticing. The caller's failure path has to see it.
      throw new MachineryAlertCycleError(
        "Machinery alert workspaces could not be enumerated.",
        { cause: error },
      );
    }
    const totals: PublicationCounts = { raised: 0, cleared: 0, failed: 0 };
    let failedOrganizations = 0;
    for (const organizationId of organizations) {
      try {
        const counts = await this.evaluate(organizationId);
        totals.raised += counts.raised;
        totals.cleared += counts.cleared;
        totals.failed += counts.failed;
      } catch (error) {
        failedOrganizations += 1;
        this.reportOrganizationFailure(organizationId, error);
      }
    }
    // Every workspace failing is the same outage as failing to enumerate them:
    // nothing was evaluated, so nothing can be alerted on.
    if (organizations.length > 0 && failedOrganizations === organizations.length) {
      throw new MachineryAlertCycleError(
        "No machinery alert workspace could be evaluated.",
      );
    }
    return this.complete({
      organizations: organizations.length,
      raised: totals.raised,
      cleared: totals.cleared,
      failedOrganizations,
      failedPublications: totals.failed,
    });
  }

  private async evaluate(organizationId: string): Promise<PublicationCounts> {
    const facts = await this.source.readFacts(organizationId);
    const counts: PublicationCounts = { raised: 0, cleared: 0, failed: 0 };
    const holding = new Set(
      facts.conditions.map((condition) => condition.recoveryKey),
    );
    const alreadyOpen = new Set(
      facts.openAlerts.map((alert) => alert.recoveryKey),
    );
    for (const condition of facts.conditions) {
      // An open alert already says this condition is holding. Publishing again
      // only inserts another durable event and bumps a counter nobody reads —
      // at a one-minute cadence that is half a million permanent rows a year
      // for one unresolved condition. It publishes again after it recovers.
      if (alreadyOpen.has(condition.recoveryKey)) continue;
      const result = await this.events.machineryConditionRaised({
        organizationId,
        condition,
      });
      if (result.status === "failed") counts.failed += 1;
      else counts.raised += 1;
    }
    // Only conditions with an alert still open are cleared, so a quiet cycle
    // publishes nothing and the event history stays proportional to reality.
    for (const alert of facts.openAlerts) {
      if (holding.has(alert.recoveryKey)) continue;
      const result = await this.events.machineryConditionCleared({
        organizationId,
        kind: alert.kind,
        recoveryKey: alert.recoveryKey,
        providerId: alert.providerId,
        runId: alert.runId,
      });
      if (result.status === "failed") counts.failed += 1;
      else counts.cleared += 1;
    }
    return counts;
  }

  private reportOrganizationFailure(
    organizationId: string,
    error: unknown,
  ): void {
    try {
      this.observer?.organizationFailed?.({ organizationId, error });
    } catch {
      // Alerting never depends on observation delivery.
    }
  }

  private complete(
    result: MachineryAlertCycleResult,
  ): MachineryAlertCycleResult {
    try {
      this.observer?.cycleCompleted(result);
    } catch {
      // Alerting never depends on observation delivery.
    }
    return result;
  }
}
