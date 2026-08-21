/**
 * Turns the machinery conditions into operational alerts on a bounded cadence.
 *
 * The service owns no thresholds and makes no judgements: a facts source hands
 * it the conditions the shared evaluations already decided, plus the machinery
 * alerts currently open, and it publishes through the existing operational
 * event path so storage, grouping, acknowledgement, and resolution stay exactly
 * as they are for every other alert.
 *
 * Deduplication is durable, not remembered here: a persisting condition keeps
 * emitting the same dedupe key, which the alert store folds onto one active
 * alert. A condition that stops holding is closed once — only alerts that are
 * actually open are cleared — and a recurrence reopens through the same
 * lifecycle.
 *
 * Every cycle is best-effort. A workspace that fails is counted and skipped so
 * one unreadable tenant cannot silence the alerting for the rest.
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
    } catch {
      return this.complete({
        organizations: 0,
        raised: 0,
        cleared: 0,
        failedOrganizations: 0,
        failedPublications: 0,
      });
    }
    const totals: PublicationCounts = { raised: 0, cleared: 0, failed: 0 };
    let failedOrganizations = 0;
    for (const organizationId of organizations) {
      try {
        const counts = await this.evaluate(organizationId);
        totals.raised += counts.raised;
        totals.cleared += counts.cleared;
        totals.failed += counts.failed;
      } catch {
        failedOrganizations += 1;
      }
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
    for (const condition of facts.conditions) {
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
