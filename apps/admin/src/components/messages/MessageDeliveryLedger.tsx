import type { MessageDeliveryIntentRow } from "@packscout/contracts";
import { Link } from "react-router-dom";
import { StatusBadge } from "../StatusBadge";
import { dateTime } from "../operations/OperationStatus";
import {
  messageKindLabel,
  messageStateDisplay,
  skipReasonLabel,
} from "./message-delivery-copy";

interface MessageDeliveryLedgerProps {
  entries: readonly MessageDeliveryIntentRow[];
  /** Ledger position of the first row on this page, one-based. */
  startIndex: number;
}

/**
 * The delivery history, newest intent first. Rows are keyed and linked on the
 * intent id — the queue's opaque UUID — so a detail URL never carries a
 * recipient; the addresses themselves render only as page content.
 */
export function MessageDeliveryLedger({
  entries,
  startIndex,
}: MessageDeliveryLedgerProps) {
  return (
    <section className="admin-surface admin-panel" aria-labelledby="message-delivery-ledger-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Delivery history</span>
          <h2 id="message-delivery-ledger-title">Messages</h2>
        </div>
        <span className="admin-section-count">
          {String(entries.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="admin-row-list">
        {entries.map((entry, index) => {
          const state = messageStateDisplay(entry.state);
          return (
            <article key={entry.intentId}>
              <span>{String(startIndex + index).padStart(2, "0")}</span>
              <div>
                <strong className="messages__recipient" title={entry.recipient}>
                  {entry.recipient}
                </strong>
                <p className="messages__kind">{messageKindLabel(entry.kind)}</p>
                <dl className="messages__facts">
                  <div>
                    <dt>Attempts</dt>
                    <dd>{entry.attemptCount}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{dateTime(entry.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Last attempt</dt>
                    <dd>{dateTime(entry.lastAttemptedAt)}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>{entry.lastProvider ?? "None yet"}</dd>
                  </div>
                  {entry.lastErrorCode !== null ? (
                    <div>
                      <dt>Error code</dt>
                      <dd className="messages__code">{entry.lastErrorCode}</dd>
                    </div>
                  ) : null}
                  {entry.lastSkipReason !== null ? (
                    <div>
                      <dt>Skipped</dt>
                      <dd>{skipReasonLabel(entry.lastSkipReason)}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              <div className="messages__row-status">
                <StatusBadge label={state.label} tone={state.tone} />
                <Link
                  className="admin-button admin-button-secondary"
                  to={`/messages/${entry.intentId}`}
                >
                  View attempts
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
