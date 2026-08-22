import type { RecomputationQueueEntry } from "@packscout/contracts";
import { QueueEntryStatus } from "./BackgroundWorkStatus";
import { age, dateTime } from "./OperationStatus";

export function isRecoverable(entry: RecomputationQueueEntry): boolean {
  return (
    entry.state === "failed" || (entry.state === "claimed" && entry.claimExpired)
  );
}

interface RecomputationQueueLedgerProps {
  entries: RecomputationQueueEntry[];
  selected: ReadonlySet<string>;
  onSelectionChange: (requestId: string, selected: boolean) => void;
}

export function RecomputationQueueLedger({
  entries,
  selected,
  onSelectionChange,
}: RecomputationQueueLedgerProps) {
  return (
    <section className="ops-ledger" aria-labelledby="recomputation-ledger-title">
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">Estimated EV recomputation</span>
          <h2 id="recomputation-ledger-title">Queue entries</h2>
        </div>
        <span className="admin-section-count">
          {String(entries.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="ops-ledger__rows">
        {entries.map((entry) => (
          <article key={entry.id}>
            <label className="ops-ledger__select">
              <input
                type="checkbox"
                disabled={!isRecoverable(entry)}
                checked={selected.has(entry.id)}
                onChange={(event) =>
                  onSelectionChange(entry.id, event.target.checked)
                }
              />
              <span className="admin-visually-hidden">
                Select recomputation {entry.packReference}
              </span>
            </label>
            <div className="ops-ledger__identity">
              <strong>{entry.packReference}</strong>
              <span>
                {entry.platformKey} · {entry.id.slice(0, 8)}
              </span>
            </div>
            <QueueEntryStatus entry={entry} />
            <dl className="ops-ledger__facts">
              <div>
                <dt>Attempts</dt>
                <dd>{entry.attemptCount}</dd>
              </div>
              <div>
                <dt>Requested</dt>
                <dd>{dateTime(entry.createdAt)}</dd>
              </div>
              <div>
                <dt>Runnable from</dt>
                <dd>{dateTime(entry.availableAt)}</dd>
              </div>
              <div>
                <dt>Claimed by</dt>
                <dd>{entry.claimedBy ?? "Unclaimed"}</dd>
              </div>
              <div>
                <dt>Claim age</dt>
                <dd>{age(entry.claimAgeMs)}</dd>
              </div>
              <div>
                <dt>Claim expires</dt>
                <dd>{dateTime(entry.claimExpiresAt)}</dd>
              </div>
            </dl>
            <p className="ops-ledger__diagnostic">
              {entry.failureSummary ??
                (entry.claimExpired
                  ? "The claim outlived its expiry. The worker holding it is not coming back."
                  : entry.state === "completed"
                    ? "The recalculation finished."
                    : "No failure recorded for this entry.")}
              {entry.failureCode ? ` (${entry.failureCode})` : ""}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
