import type { DatabaseStatusPayload } from "../../api/panel-types.ts";
import { readMigrationHealth } from "../../database/status-presentation.ts";

/**
 * Migration state, compared name by name against the repository. A database the
 * panel could not read reports that plainly instead of implying "current".
 */
export function MigrationStateCard({ status }: { status: DatabaseStatusPayload }) {
  const migrations = status.migrations;

  if (migrations === null) {
    return (
      <section className="panel-card" aria-labelledby="database-migrations-heading">
        <div className="panel-card-header">
          <h2 id="database-migrations-heading">Migrations</h2>
          <span className="panel-status" data-tone="neutral">
            Unknown
          </span>
        </div>
        <p className="panel-card-headline">
          The panel could not read this database&rsquo;s migration history, so it
          will not claim the schema is current or behind.
        </p>
      </section>
    );
  }

  const reading = readMigrationHealth(migrations.health);
  const notable = migrations.entries.filter((entry) => entry.outcome !== "applied");

  return (
    <section className="panel-card" aria-labelledby="database-migrations-heading">
      <div className="panel-card-header">
        <h2 id="database-migrations-heading">Migrations</h2>
        <span className="panel-status" data-tone={reading.tone}>
          {reading.label}
        </span>
      </div>

      <p className="panel-card-headline">{migrations.summary}</p>
      <p className="panel-card-note">
        History is aggregated by migration name, so one that was rolled back and
        reapplied reads as applied.
      </p>

      {notable.length === 0 ? null : (
        <div className="panel-table-scroll">
          <table>
            <caption>Migrations needing attention</caption>
            <thead>
              <tr>
                <th scope="col">Migration</th>
                <th scope="col">State</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {notable.map((entry) => (
                <tr key={entry.name}>
                  <td className="panel-mono">{entry.name}</td>
                  <td>{entry.outcome.replace(/_/gu, " ")}</td>
                  <td>{entry.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
