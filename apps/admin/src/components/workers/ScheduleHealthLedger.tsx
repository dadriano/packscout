import { Link } from "react-router-dom";
import { importRunDetailPath, type ScheduleHealthView } from "@packscout/contracts";
import { age, dateTime, humanize } from "../operations/OperationStatus";
import { ScheduleStatus } from "./WorkerFleetStatus";

function scheduleDiagnostic(schedule: ScheduleHealthView): string {
  const { health } = schedule;
  if (health.state === "claim_expired") {
    const owner = schedule.claimOwner ?? "a departed worker";
    const known = schedule.claimOwnerPresent
      ? "that instance still reports presence"
      : "that instance no longer reports presence";
    return `A claim held by ${owner} outlived its expiry — ${known}. The schedule stays wedged until the claim is reclaimed.`;
  }
  if (health.state === "overdue") {
    return `Past due by ${age(health.overdueByMs)}, longer than the ${age(health.overdueAfterMs)} window a live worker is given to claim it.`;
  }
  if (health.state === "due") {
    return health.overdueAfterMs === null
      ? "Due now. No worker has published its operating settings, so how late is too late cannot be judged yet."
      : `Due now, ${age(health.overdueByMs)} past its time and still inside the ${age(health.overdueAfterMs)} claim window.`;
  }
  return "Next run is still ahead of its due time.";
}

export function ScheduleHealthLedger({
  schedules,
}: {
  schedules: ScheduleHealthView[];
}) {
  return (
    <section className="ops-ledger" aria-labelledby="schedule-health-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Provider scheduling</span>
          <h2 id="schedule-health-title">Schedule health</h2>
        </div>
        <span className="admin-section-count">
          {String(schedules.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="ops-ledger__rows">
        {schedules.map((schedule) => (
          <article key={schedule.providerId}>
            <div className="ops-ledger__identity">
              <Link to={`/providers/${schedule.providerId}`}>
                {schedule.providerName}
              </Link>
              <span>{schedule.platformKey}</span>
            </div>
            <ScheduleStatus state={schedule.health.state} />
            <dl className="ops-ledger__facts">
              <div>
                <dt>Next due</dt>
                <dd>{dateTime(schedule.nextDueAt)}</dd>
              </div>
              <div>
                <dt>Overdue by</dt>
                <dd>
                  {schedule.health.overdueByMs === null
                    ? "Not due yet"
                    : age(schedule.health.overdueByMs)}
                </dd>
              </div>
              <div>
                <dt>Claim holder</dt>
                <dd>{schedule.claimOwner ?? "Unclaimed"}</dd>
              </div>
              <div>
                <dt>Claim expires</dt>
                <dd>{dateTime(schedule.claimExpiresAt)}</dd>
              </div>
              <div>
                <dt>Claim held for</dt>
                <dd>
                  {schedule.health.claimHeldForMs === null
                    ? "Never claimed"
                    : age(schedule.health.claimHeldForMs)}
                </dd>
              </div>
              <div>
                <dt>Last outcome</dt>
                <dd>
                  {schedule.lastOutcome
                    ? humanize(schedule.lastOutcome)
                    : "Not recorded"}
                </dd>
              </div>
            </dl>
            <p className="ops-ledger__links">
              <Link to={`/providers/${schedule.providerId}`}>
                Open provider detail
              </Link>
              {schedule.lastRunId ? (
                <Link to={importRunDetailPath({ providerId: schedule.providerId, runId: schedule.lastRunId })}>Open last run</Link>
              ) : null}
            </p>
            <p className="ops-ledger__diagnostic">
              {scheduleDiagnostic(schedule)}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
