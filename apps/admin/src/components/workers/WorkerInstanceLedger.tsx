import { Link } from "react-router-dom";
import type { WorkerInstanceView } from "@packscout/contracts";
import { age, dateTime } from "../operations/OperationStatus";
import { LivenessStatus, activityLabel } from "./WorkerFleetStatus";

function instanceDiagnostic(instance: WorkerInstanceView): string {
  if (instance.status === "stale") {
    return `The last heartbeat is ${age(instance.heartbeatAgeMs)} old, past the ${age(instance.effectiveSettings.presenceStaleAfterMs)} staleness window this instance published. Treat it as gone rather than working.`;
  }
  if (instance.status === "stopped") {
    return "The instance shut down cleanly and released its work.";
  }
  return `Heartbeating every ${age(instance.effectiveSettings.heartbeatIntervalMs)}, inside its ${age(instance.effectiveSettings.presenceStaleAfterMs)} staleness window.`;
}

export function WorkerInstanceLedger({
  instances,
}: {
  instances: WorkerInstanceView[];
}) {
  return (
    <section className="ops-ledger" aria-labelledby="worker-instance-title">
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">Worker presence</span>
          <h2 id="worker-instance-title">Instances</h2>
        </div>
        <span className="admin-section-count">
          {String(instances.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="ops-ledger__rows">
        {instances.map((instance) => (
          <article key={instance.instanceId}>
            <div className="ops-ledger__identity">
              <strong>{instance.instanceId}</strong>
              <span>
                {instance.host} · Version {instance.version} · Node{" "}
                {instance.runtimeVersion}
              </span>
            </div>
            <LivenessStatus status={instance.status} />
            <dl className="ops-ledger__facts">
              <div>
                <dt>Doing now</dt>
                <dd>{activityLabel(instance.activity)}</dd>
              </div>
              <div>
                <dt>Activity age</dt>
                <dd>
                  {instance.activity.ageMs === null
                    ? "Not working"
                    : age(instance.activity.ageMs)}
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{dateTime(instance.startedAt)}</dd>
              </div>
              <div>
                <dt>Up for</dt>
                <dd>{age(instance.upForMs)}</dd>
              </div>
              <div>
                <dt>Last heartbeat</dt>
                <dd>{dateTime(instance.lastHeartbeatAt)}</dd>
              </div>
              <div>
                <dt>Heartbeat age</dt>
                <dd>{age(instance.heartbeatAgeMs)}</dd>
              </div>
              <div>
                <dt>Stopped</dt>
                <dd>{dateTime(instance.stoppedAt)}</dd>
              </div>
            </dl>
            {instance.activity.runId || instance.activity.providerId ? (
              <p className="ops-ledger__links">
                {instance.activity.runId ? (
                  <Link to={`/runs/${instance.activity.runId}`}>
                    Open the run it is working
                  </Link>
                ) : null}
                {instance.activity.providerId ? (
                  <Link to={`/providers/${instance.activity.providerId}`}>
                    Open the provider
                  </Link>
                ) : null}
              </p>
            ) : null}
            <p className="ops-ledger__diagnostic">
              {instanceDiagnostic(instance)}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
