import type { RetentionExecutionSummary } from "@packscout/contracts";
import { RetentionStatus } from "./BackgroundWorkStatus";
import { age, dateTime } from "./OperationStatus";

export function RetentionExecutionLedger({
  executions,
}: {
  executions: RetentionExecutionSummary[];
}) {
  return (
    <section className="ops-ledger" aria-labelledby="retention-ledger-title">
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">Protected payload cleanup</span>
          <h2 id="retention-ledger-title">Retention executions</h2>
        </div>
        <span className="admin-section-count">
          {String(executions.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="ops-ledger__rows">
        {executions.map((execution) => (
          <article key={execution.id}>
            <div className="ops-ledger__identity">
              <strong>{dateTime(execution.startedAt)}</strong>
              <span>{execution.id.slice(0, 8)}</span>
            </div>
            <RetentionStatus state={execution.state} />
            <dl className="ops-ledger__facts">
              <div>
                <dt>Finished</dt>
                <dd>{dateTime(execution.finishedAt)}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>
                  {execution.durationMs === null
                    ? "Still running"
                    : age(execution.durationMs)}
                </dd>
              </div>
              <div>
                <dt>Pruned</dt>
                <dd>{execution.pruned.total}</dd>
              </div>
              <div>
                <dt>Pages</dt>
                <dd>{execution.pruned.pages}</dd>
              </div>
              <div>
                <dt>Source records</dt>
                <dd>{execution.pruned.sourceRecords}</dd>
              </div>
              <div>
                <dt>Quarantines</dt>
                <dd>{execution.pruned.quarantines}</dd>
              </div>
              <div>
                <dt>Already expired</dt>
                <dd>{execution.alreadyExpired}</dd>
              </div>
              <div>
                <dt>Remaining</dt>
                <dd>{execution.remaining}</dd>
              </div>
              <div>
                <dt>Cutoff</dt>
                <dd>{dateTime(execution.cutoffAt)}</dd>
              </div>
            </dl>
            <p className="ops-ledger__diagnostic">
              {execution.failureSummary ??
                "The cleanup completed within its bounded batch."}
              {execution.failureCode ? ` (${execution.failureCode})` : ""}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
