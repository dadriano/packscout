import type {
  PromotionJobAttemptMonitoring,
  PromotionJobInvocationDetail,
} from "@packscout/contracts";
import { humanize } from "../operations/OperationStatus";
import {
  Digest,
  MonitoringTime,
  PromotionJobStatus,
} from "./PromotionJobStatus";

function Attempt({ attempt }: { attempt: PromotionJobAttemptMonitoring }) {
  return (
    <details className="promotion-attempt">
      <summary>
        <span>
          <strong>Attempt {attempt.attemptNumber}</strong>
          <small>{humanize(attempt.kind)} · target {attempt.targetPosition}</small>
        </span>
        <PromotionJobStatus value={attempt.state} />
      </summary>
      <dl className="promotion-attempt-facts">
        <div><dt>Observed</dt><dd><MonitoringTime value={attempt.observedAt} /></dd></div>
        <div><dt>Retries</dt><dd>{attempt.retryCount}</dd></div>
        <div><dt>Failure</dt><dd>{attempt.failureCode ?? "None"}</dd></div>
        <div><dt>Public release</dt><dd>{attempt.publicReleaseId ?? "None"}</dd></div>
        <div><dt>Release fingerprint</dt><dd><Digest value={attempt.releaseFingerprint} /></dd></div>
        <div><dt>Ordered operations</dt><dd><Digest value={attempt.orderedOperationDigest} /></dd></div>
        <div><dt>Operation summaries</dt><dd><Digest value={attempt.operationSummariesDigest} /></dd></div>
      </dl>
      <p className="promotion-bounds-note">
        Showing {attempt.operations.length} of {attempt.totalOperationCount} safe
        operation summaries
        {attempt.truncatedOperationCount > 0
          ? ` · ${attempt.truncatedOperationCount} omitted by the monitoring bound`
          : ""}.
      </p>
      {attempt.operations.length > 0 ? (
        <div className="promotion-table-region" role="region" aria-label={`Attempt ${attempt.attemptNumber} operations`} tabIndex={0}>
          <table className="promotion-operation-table">
            <caption className="admin-visually-hidden">Attempt {attempt.attemptNumber} operations</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Kind</th>
                <th scope="col">State</th>
                <th scope="col">Sends</th>
                <th scope="col">Sent</th>
                <th scope="col">Acknowledged</th>
                <th scope="col">Evidence digests</th>
              </tr>
            </thead>
            <tbody>
              {attempt.operations.map((operation) => (
                <tr key={operation.operationNumber}>
                  <th scope="row">{operation.operationNumber}</th>
                  <td data-label="Kind">{humanize(operation.kind)}</td>
                  <td data-label="State"><PromotionJobStatus value={operation.state} /></td>
                  <td data-label="Sends">{operation.sendCount}</td>
                  <td data-label="Sent"><MonitoringTime value={operation.sentAt} /></td>
                  <td data-label="Acknowledged"><MonitoringTime value={operation.acknowledgedAt} /></td>
                  <td data-label="Evidence digests">
                    <span className="promotion-digest-stack">
                      <Digest value={operation.operationIdDigest} />
                      <Digest value={operation.requestDigest} />
                      <Digest value={operation.receiptDigest} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

export function PromotionJobDetail({
  detail,
}: {
  detail: PromotionJobInvocationDetail;
}) {
  const { invocation } = detail;
  return (
    <>
      <section className="promotion-detail-lead" aria-labelledby="promotion-detail-state">
        <div>
          <span className="admin-kicker">{invocation.job === "manifest" ? "Central manifest" : invocation.job.slice(9)}</span>
          <h2 id="promotion-detail-state">{humanize(invocation.outcome ?? invocation.state)}</h2>
          <p>
            {humanize(invocation.trigger)} · {invocation.cycleCount} cycles · {invocation.retryCount} retries
          </p>
        </div>
        <PromotionJobStatus value={invocation.outcome ?? invocation.state} />
      </section>

      <section className="promotion-detail-facts" aria-labelledby="promotion-detail-facts-title">
        <h2 id="promotion-detail-facts-title">Invocation facts</h2>
        <dl>
          <div><dt>Requested</dt><dd><MonitoringTime value={invocation.requestedAt} /></dd></div>
          <div><dt>Started</dt><dd><MonitoringTime value={invocation.startedAt} /></dd></div>
          <div><dt>Finished</dt><dd><MonitoringTime value={invocation.finishedAt} /></dd></div>
          <div><dt>Duration</dt><dd>{invocation.durationMs === null ? "Not complete" : `${invocation.durationMs.toLocaleString("en-US")} ms`}</dd></div>
          <div><dt>Attempts</dt><dd>{invocation.attemptCount}</dd></div>
          <div><dt>Continuation</dt><dd>{invocation.continuationPending ? "Pending" : "None"}</dd></div>
          <div><dt>Failure code</dt><dd>{invocation.failureCode ?? "None"}</dd></div>
        </dl>
      </section>

      <section className="promotion-attempts" aria-labelledby="promotion-attempts-title">
        <header>
          <div>
            <span className="admin-kicker">Bounded safe evidence</span>
            <h2 id="promotion-attempts-title">Attempts</h2>
          </div>
          <strong>{detail.attempts.length} of {detail.totalAttemptCount}</strong>
        </header>
        <p className="promotion-bounds-note">
          At most 25 attempts and 25 operations per attempt are shown.
          {detail.truncatedAttemptCount > 0
            ? ` ${detail.truncatedAttemptCount} older attempts are omitted.`
            : ""}
        </p>
        <div className="promotion-attempt-digest">
          <span>Attempt set digest</span>
          <Digest value={detail.attemptSetDigest} />
        </div>
        {detail.attempts.length > 0 ? (
          <div className="promotion-attempt-list">
            {detail.attempts.map((attempt) => <Attempt key={attempt.attemptNumber} attempt={attempt} />)}
          </div>
        ) : (
          <p className="promotion-empty-copy">No attempt evidence was recorded for this invocation.</p>
        )}
      </section>
    </>
  );
}
