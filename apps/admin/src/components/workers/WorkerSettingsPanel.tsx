import type { WorkerFleetSettingsResolution } from "@packscout/contracts";
import { age, dateTime } from "../operations/OperationStatus";

function days(value: number): string {
  return `${value} day${value === 1 ? "" : "s"}`;
}

function provenance(resolution: WorkerFleetSettingsResolution): string {
  if (resolution.source === "mixed") {
    return `${resolution.publishers} instances published settings and they disagree, so the most permissive value governs each threshold below.`;
  }
  return `Published by ${resolution.publishers} instance${resolution.publishers === 1 ? "" : "s"}. These are the values the fleet is actually running with, read from what it published — the admin keeps no copy of them.`;
}

/**
 * Read-only operating settings. Per-provider schedule cadence and staleness stay
 * on the provider pages; this panel only states the worker-runtime values that
 * are configured outside the admin, so an operator can interpret what "stale"
 * and "overdue" mean above.
 */
export function WorkerSettingsPanel({
  resolution,
  observedAt,
}: {
  resolution: WorkerFleetSettingsResolution;
  observedAt: string | null;
}) {
  const settings = resolution.settings;
  return (
    <section className="ops-detail" aria-labelledby="worker-settings-title">
      <header>
        <span className="admin-kicker">Effective worker settings</span>
        <h2 id="worker-settings-title">Operating thresholds in force</h2>
      </header>
      {settings === null ? (
        <p>
          No instance has published its operating settings inside the retained
          window, so no threshold can be stated. Staleness and overdue judgements
          above are withheld rather than measured against a value the admin
          invented.
        </p>
      ) : (
        <>
          <dl>
            <div>
              <dt>Heartbeat cadence</dt>
              <dd>{age(settings.heartbeatIntervalMs)}</dd>
            </div>
            <div>
              <dt>Presence stale after</dt>
              <dd>{age(settings.presenceStaleAfterMs)}</dd>
            </div>
            <div>
              <dt>Run heartbeat stale after</dt>
              <dd>{age(settings.runHeartbeatStaleAfterMs)}</dd>
            </div>
            <div>
              <dt>Schedule claim lease</dt>
              <dd>{age(settings.scheduleClaimLeaseMs)}</dd>
            </div>
            <div>
              <dt>Import run lease</dt>
              <dd>{age(settings.importRunLeaseMs)}</dd>
            </div>
            <div>
              <dt>Protected payload retention</dt>
              <dd>{days(settings.protectedPayloadRetentionDays)}</dd>
            </div>
            <div>
              <dt>Presence retention</dt>
              <dd>{days(settings.presenceRetentionDays)}</dd>
            </div>
            <div>
              <dt>Read at</dt>
              <dd>{dateTime(observedAt)}</dd>
            </div>
          </dl>
          <p>{provenance(resolution)}</p>
        </>
      )}
    </section>
  );
}
