import type { DatabaseStatusPayload } from "../../api/panel-types.ts";
import {
  describeLocality,
  describeTarget,
  formatApproximateRows,
  readHealth,
} from "../../database/status-presentation.ts";
import { formatByteSize } from "../../format.ts";

/**
 * What the database is, whether it is this machine's, whether it answered, and
 * how big it is. When one of those statements fails, the card says which one and
 * what to do about it rather than showing an empty shell.
 */
export function DatabaseStatusCard({ status }: { status: DatabaseStatusPayload }) {
  const health = readHealth(status.health);
  const locality = describeLocality(status);
  const identity = status.target.identity;

  return (
    <section className="panel-card" aria-labelledby="database-status-heading">
      <div className="panel-card-header">
        <h2 id="database-status-heading">Connection</h2>
        <span className="panel-status" data-tone={health.tone}>
          {health.label}
        </span>
        <span className="panel-status" data-tone={locality.tone}>
          {locality.label}
        </span>
      </div>

      <p className="panel-card-headline">{status.headline}</p>
      {health.nextStep ? (
        <p
          className="panel-notice"
          data-tone={health.tone}
          role={health.tone === "danger" ? "alert" : undefined}
        >
          {health.nextStep}
        </p>
      ) : null}
      {status.detail ? (
        <p className="panel-card-detail panel-mono">{status.detail}</p>
      ) : null}

      <dl className="panel-facts">
        <div>
          <dt>Target</dt>
          <dd className="panel-mono">{describeTarget(status)}</dd>
        </div>
        <div>
          <dt>Configured by</dt>
          <dd className="panel-mono">{status.target.variableName}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{status.sizeBytes === null ? "—" : formatByteSize(status.sizeBytes)}</dd>
        </div>
        <div>
          <dt>Reachability</dt>
          <dd>{status.reachability.replace(/_/gu, " ")}</dd>
        </div>
      </dl>
      {identity === null ? null : (
        <p className="panel-card-note">
          Credentials are resolved on the server and never leave it: this page
          only ever receives a host, a port, and a database name.
        </p>
      )}

      {status.tables.length > 0 ? (
        <div className="panel-table-scroll">
          <table>
            <caption>Largest tables, by total size on disk</caption>
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Rows (approximate)</th>
                <th scope="col">Size</th>
              </tr>
            </thead>
            <tbody>
              {status.tables.map((table) => (
                <tr key={table.name}>
                  <td className="panel-mono">{table.name}</td>
                  <td>{formatApproximateRows(table.approximateRows)}</td>
                  <td>{formatByteSize(table.totalBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
