import type {
  PromotionJobHistoryPage,
  PromotionJobInvocationMonitoring,
} from "@packscout/contracts";
import { Link } from "react-router-dom";
import { humanize } from "../operations/OperationStatus";
import { MonitoringTime, PromotionJobStatus } from "./PromotionJobStatus";

function InvocationRow({
  invocation,
}: {
  invocation: PromotionJobInvocationMonitoring;
}) {
  const label = invocation.job === "manifest"
    ? "Central manifest"
    : invocation.job.slice("provider:".length);
  return (
    <tr>
      <th scope="row">
        <Link to={`/promotion-jobs/${invocation.monitoringId}`}>{label}</Link>
        <small>{humanize(invocation.trigger)}</small>
      </th>
      <td data-label="Status">
        <PromotionJobStatus value={invocation.outcome ?? invocation.state} />
        {invocation.continuationPending ? <small>Continuation pending</small> : null}
      </td>
      <td data-label="Started"><MonitoringTime value={invocation.startedAt} /></td>
      <td data-label="Duration">
        {invocation.durationMs === null
          ? invocation.state === "running" ? "Running" : "Not recorded"
          : `${invocation.durationMs.toLocaleString("en-US")} ms`}
      </td>
      <td data-label="Work">
        <span>{invocation.cycleCount} cycles</span>
        <small>{invocation.attemptCount} attempts · {invocation.retryCount} retries</small>
      </td>
      <td data-label="Failure">
        {invocation.failureCode ? <code>{invocation.failureCode}</code> : "None"}
      </td>
    </tr>
  );
}

export function PromotionHistory({
  page,
}: {
  page: PromotionJobHistoryPage;
}) {
  if (page.items.length === 0) {
    return (
      <section className="promotion-empty-roster">
        <span className="admin-kicker">Invocation history</span>
        <h2>No promotion jobs match these filters</h2>
        <p>Change or reset the filters to inspect another safe history scope.</p>
      </section>
    );
  }
  return (
    <div
      className="promotion-table-region"
      role="region"
      aria-label="Promotion job history"
      tabIndex={0}
    >
      <table className="promotion-history-table">
        <caption className="admin-visually-hidden">Promotion job history</caption>
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            <th scope="col">Duration</th>
            <th scope="col">Work</th>
            <th scope="col">Failure</th>
          </tr>
        </thead>
        <tbody>{page.items.map((item) => <InvocationRow key={item.monitoringId} invocation={item} />)}</tbody>
      </table>
    </div>
  );
}
