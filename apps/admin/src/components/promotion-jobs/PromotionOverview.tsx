import type {
  ManifestPromotionJobMonitoring,
  PromotionJobEvaluatorMonitoring,
  PromotionJobMonitoringOverview,
  ProviderPromotionJobMonitoring,
} from "@packscout/contracts";
import { Link } from "react-router-dom";
import { age, humanize } from "../operations/OperationStatus";
import {
  Digest,
  MonitoringTime,
  PromotionJobStatus,
} from "./PromotionJobStatus";

function latestJobLink(
  invocation: ProviderPromotionJobMonitoring["latestInvocation"],
) {
  if (!invocation) return <span>None recorded</span>;
  return (
    <Link to={`/promotion-jobs/${invocation.monitoringId}`}>
      {humanize(invocation.outcome ?? invocation.state)}
    </Link>
  );
}

function EvaluatorNotice({
  evaluator,
  rosterDigest,
}: {
  evaluator: PromotionJobEvaluatorMonitoring;
  rosterDigest: string;
}) {
  const rosterChanged =
    evaluator.rosterDigest !== null && evaluator.rosterDigest !== rosterDigest;
  if (evaluator.state === "current" && !rosterChanged) {
    return (
      <aside className="promotion-evaluator promotion-evaluator--current">
        <div>
          <span className="admin-kicker">Liveness evaluator</span>
          <strong>Current for this provider roster</strong>
        </div>
        <dl>
          <div><dt>Reachable</dt><dd>{evaluator.reachableCount ?? "—"}</dd></div>
          <div><dt>Unavailable</dt><dd>{evaluator.unavailableCount ?? "—"}</dd></div>
          <div><dt>Evaluated through</dt><dd><MonitoringTime value={evaluator.evaluatedThrough} /></dd></div>
        </dl>
      </aside>
    );
  }
  return (
    <aside
      className="promotion-evaluator promotion-evaluator--attention"
      role="status"
      aria-live="polite"
    >
      <div>
        <span className="admin-kicker">Liveness evaluator</span>
        <strong>
          {rosterChanged
            ? "Provider roster changed; liveness is last-known"
            : evaluator.state === "stale"
              ? "Liveness judgment is stale"
              : evaluator.state === "failed"
                ? "Liveness evaluation failed"
                : "Liveness evaluation is pending"}
        </strong>
        <p>
          Publication facts below remain visible. Treat schedule judgments as
          last-known until the evaluator catches up.
        </p>
      </div>
      <PromotionJobStatus value={evaluator.state} />
    </aside>
  );
}

function ManifestIdentity({
  label,
  identity,
}: {
  label: string;
  identity: ManifestPromotionJobMonitoring["activeManifest"];
}) {
  return (
    <div className="promotion-release-card">
      <span>{label}</span>
      {identity ? (
        <dl>
          <div><dt>Manifest</dt><dd>{identity.publicManifestId}</dd></div>
          <div><dt>Generation</dt><dd>{identity.generation}</dd></div>
          <div><dt>Activated</dt><dd><MonitoringTime value={identity.activatedAt} /></dd></div>
          <div><dt>Fingerprint</dt><dd><Digest value={identity.fingerprint} /></dd></div>
        </dl>
      ) : <strong>None recorded</strong>}
    </div>
  );
}

function ManifestCoordinator({
  manifest,
}: {
  manifest: ManifestPromotionJobMonitoring;
}) {
  return (
    <section className="promotion-manifest" aria-labelledby="manifest-title">
      <header>
        <div>
          <span className="admin-kicker">Central coordinator</span>
          <h2 id="manifest-title">Manifest activation</h2>
          <p>
            Central switches one provider release at a time. Other providers
            remain independent when one gate is delayed.
          </p>
        </div>
        <div className="promotion-status-stack">
          <PromotionJobStatus value={manifest.evidenceSource} />
          {manifest.stale ? <PromotionJobStatus value="stale" /> : null}
        </div>
      </header>

      {manifest.evidenceSource === "unavailable" ? (
        <div className="promotion-inline-alert" role="status">
          Central manifest evidence is unavailable. Provider publication facts
          below remain independent and visible.
        </div>
      ) : null}

      <dl className="promotion-manifest-metrics">
        <div>
          <dt>Schedule</dt>
          <dd>{manifest.schedule ? <PromotionJobStatus value={manifest.schedule.health} /> : "Not observed"}</dd>
        </div>
        <div>
          <dt>Wake</dt>
          <dd>{manifest.wake ? <PromotionJobStatus value={manifest.wake.pending ? "pending" : "caught_up"} /> : "Not observed"}</dd>
        </div>
        <div><dt>Queued gates</dt><dd>{manifest.gateQueueDepth}</dd></div>
        <div><dt>Oldest gate</dt><dd>{age(manifest.oldestGateAgeMs)}</dd></div>
        <div><dt>Last activation</dt><dd><MonitoringTime value={manifest.lastActivationAt} /></dd></div>
        <div><dt>Last reconciliation</dt><dd><MonitoringTime value={manifest.lastReconciliationAt} /></dd></div>
      </dl>

      {manifest.serializedOperation ? (
        <div className="promotion-gate-focus">
          <div>
            <span className="admin-kicker">Serialized gate in progress</span>
            <strong>
              {humanize(manifest.serializedOperation.operation)} · {manifest.serializedOperation.providerKey}
            </strong>
            <p>
              Attempt {manifest.serializedOperation.attemptCount}
              {manifest.serializedOperation.failureCode
                ? ` · ${manifest.serializedOperation.failureCode}`
                : ""}
            </p>
          </div>
          <PromotionJobStatus value={manifest.serializedOperation.state} />
        </div>
      ) : (
        <div className="promotion-gate-focus promotion-gate-focus--quiet">
          <div>
            <span className="admin-kicker">Serialized gate</span>
            <strong>No central gate operation is in flight</strong>
          </div>
        </div>
      )}

      <div className="promotion-release-grid">
        <ManifestIdentity label="Active manifest" identity={manifest.activeManifest} />
        <ManifestIdentity label="Previous manifest" identity={manifest.previousManifest} />
      </div>

      <div className="promotion-latest-job">
        <span>Latest central job</span>
        {manifest.latestInvocation ? (
          <Link to={`/promotion-jobs/${manifest.latestInvocation.monitoringId}`}>
            {humanize(manifest.latestInvocation.outcome ?? manifest.latestInvocation.state)}
          </Link>
        ) : <strong>None recorded</strong>}
      </div>
    </section>
  );
}

function providerCallout(provider: ProviderPromotionJobMonitoring): string | null {
  if (provider.lifecycle === "disabled" && provider.activeRelease) {
    return "Disabled, but its last release is still active in the manifest.";
  }
  if (provider.lifecycle === "archived" && provider.evidenceSource === "last_known") {
    return "Archived provider with retained last-known evidence.";
  }
  if (provider.state === "awaiting_activation") {
    return "Publication completed; central activation is still pending.";
  }
  if (provider.evidenceSource === "unavailable") {
    return "Provider database is unavailable; no recovery is inferred.";
  }
  return null;
}

function releaseSummary(
  release: ProviderPromotionJobMonitoring["completedRelease"],
) {
  if (!release) return <span>None</span>;
  return (
    <span>
      {release.publicReleaseId}
      <small>Position {release.position}</small>
    </span>
  );
}

function ProviderRoster({
  providers,
}: {
  providers: readonly ProviderPromotionJobMonitoring[];
}) {
  return (
    <section className="promotion-roster" aria-labelledby="provider-roster-title">
      <header>
        <div>
          <span className="admin-kicker">Independent workers</span>
          <h2 id="provider-roster-title">Provider publication</h2>
          <p>Each provider advances from its own canonical PostgreSQL database.</p>
        </div>
        <strong>{providers.length} observed</strong>
      </header>
      <div
        className="promotion-table-region"
        role="region"
        aria-label="Provider promotion status"
        tabIndex={0}
      >
        <table className="promotion-provider-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Publication</th>
              <th>Central selection</th>
              <th>Schedule</th>
              <th>Evidence</th>
              <th>Latest job</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => {
              const callout = providerCallout(provider);
              return (
                <tr key={provider.providerKey}>
                  <th scope="row">
                    <Link to={`/data/published?provider=${encodeURIComponent(provider.providerKey)}`}>
                      {provider.displayName}
                    </Link>
                    <code>{provider.providerKey}</code>
                    <span className="promotion-cell-badges">
                      <PromotionJobStatus value={provider.lifecycle} />
                      <PromotionJobStatus value={provider.state} />
                    </span>
                    {callout ? <small>{callout}</small> : null}
                  </th>
                  <td data-label="Publication">
                    {releaseSummary(provider.completedRelease)}
                    <small>Settled position {provider.settledPosition ?? "—"}</small>
                  </td>
                  <td data-label="Central selection">
                    {releaseSummary(provider.activeRelease)}
                    {provider.pendingGate ? (
                      <span className="promotion-cell-badges">
                        <PromotionJobStatus value={provider.pendingGate.operation} />
                        <PromotionJobStatus value={provider.pendingGate.state} />
                      </span>
                    ) : <small>No pending gate</small>}
                  </td>
                  <td data-label="Schedule">
                    {provider.schedule ? <PromotionJobStatus value={provider.schedule.health} /> : <span>Not observed</span>}
                    {provider.wake?.pending ? <small>Immediate wake pending</small> : null}
                  </td>
                  <td data-label="Evidence">
                    <span className="promotion-cell-badges">
                      <PromotionJobStatus value={provider.evidenceSource} />
                      {provider.stale ? <PromotionJobStatus value="stale" /> : null}
                    </span>
                    <small><MonitoringTime value={provider.observedAt} /></small>
                    {provider.routeFailureCode ? <code>{provider.routeFailureCode}</code> : null}
                  </td>
                  <td data-label="Latest job">
                    {latestJobLink(provider.latestInvocation)}
                    {provider.latestInvocation ? (
                      <small><MonitoringTime value={provider.latestInvocation.finishedAt ?? provider.latestInvocation.startedAt} /></small>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PromotionOverview({
  overview,
}: {
  overview: PromotionJobMonitoringOverview;
}) {
  return (
    <>
      <EvaluatorNotice evaluator={overview.evaluator} rosterDigest={overview.roster.digest} />
      <ManifestCoordinator manifest={overview.manifest} />
      {overview.providers.length > 0 ? (
        <ProviderRoster providers={overview.providers} />
      ) : (
        <section className="promotion-empty-roster">
          <span className="admin-kicker">Independent workers</span>
          <h2>No providers are in the monitored roster</h2>
          <p>Provider rows appear after the trusted central roster is observed.</p>
        </section>
      )}
    </>
  );
}
