import type { ReactNode } from "react";
import { EmptyState } from "../components/EmptyState";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { age } from "../components/operations/OperationStatus";
import { PageHeader } from "../components/PageHeader";
import { ScheduleHealthLedger } from "../components/workers/ScheduleHealthLedger";
import { StalledRunLedger } from "../components/workers/StalledRunLedger";
import {
  FleetStatus,
  fleetHeadline,
} from "../components/workers/WorkerFleetStatus";
import { WorkerInstanceLedger } from "../components/workers/WorkerInstanceLedger";
import { WorkerSettingsPanel } from "../components/workers/WorkerSettingsPanel";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  useScheduleHealth,
  useStalledRuns,
  useWorkerInstances,
  useWorkerSettings,
  WORKER_FLEET_REFRESH_MS,
  type KeysetPage,
} from "../hooks/worker-fleet/useWorkerFleet";

function SectionState({
  loading,
  error,
  onRetry,
  loadingLabel,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  loadingLabel: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="ops-loading" aria-live="polite" aria-busy="true">
        {loadingLabel}
      </div>
    );
  }
  if (error) {
    return (
      <div className="ops-error" role="alert">
        <p>{error}</p>
        <button
          type="button"
          className="admin-button admin-button--secondary"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

function Pagination({ pagination }: { pagination: KeysetPage }) {
  return (
    <KeysetPagination
      page={pagination.page}
      hasPrevious={pagination.hasPrevious}
      hasNext={pagination.hasNext}
      onPrevious={pagination.goPrevious}
      onNext={pagination.goNext}
    />
  );
}

export function WorkerFleetPage() {
  useDocumentTitle("Workers");
  const fleet = useWorkerInstances();
  const stalled = useStalledRuns();
  const schedules = useScheduleHealth();
  const settings = useWorkerSettings();

  const evaluation = fleet.fleet;
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Data pipeline / Workers"
        title="Worker fleet"
        description={`Whether the machinery behind provider imports is running, what each instance is doing, and which runs or schedules have slipped. Status refreshes every ${age(WORKER_FLEET_REFRESH_MS)} while this tab is visible.`}
      />

      <SectionState
        loading={fleet.loading}
        error={fleet.error}
        onRetry={fleet.reload}
        loadingLabel="Loading worker presence…"
      >
        {evaluation ? (
          <>
            <section
              className={`ops-run-lead${
                evaluation.state === "silent" ||
                evaluation.state === "never_reported"
                  ? " ops-diagnostic"
                  : ""
              }`}
              aria-labelledby="fleet-state-title"
            >
              <div>
                <span className="admin-eyebrow">Fleet state</span>
                <h2 id="fleet-state-title">
                  {evaluation.state === "healthy"
                    ? "Workers are running"
                    : evaluation.state === "degraded"
                      ? "Workers are running with problems"
                      : evaluation.state === "silent"
                        ? "No worker is alive"
                        : "No worker has ever reported"}
                </h2>
                <p aria-live="polite">{fleetHeadline(evaluation)}</p>
              </div>
              <FleetStatus state={evaluation.state} />
            </section>

            <section className="ops-metrics" aria-label="Fleet measures">
              <div>
                <span>Live instances</span>
                <strong>{evaluation.live}</strong>
                <small>{evaluation.observed} retained records</small>
              </div>
              <div>
                <span>Stale instances</span>
                <strong>{evaluation.stale}</strong>
                <small>Past their published heartbeat window</small>
              </div>
              <div>
                <span>Stopped instances</span>
                <strong>{evaluation.stopped}</strong>
                <small>Shut down cleanly</small>
              </div>
              <div>
                <span>Fleet silence</span>
                <strong>
                  {evaluation.state === "never_reported"
                    ? "Never"
                    : evaluation.silentForMs === null
                      ? "None"
                      : age(evaluation.silentForMs)}
                </strong>
                <small>
                  {evaluation.state === "never_reported"
                    ? "No record inside the retention window"
                    : "Since the most recent heartbeat"}
                </small>
              </div>
              <div>
                <span>Stalled runs</span>
                <strong>{evaluation.stalledRuns}</strong>
                <small>Past the published run-heartbeat window</small>
              </div>
              <div>
                <span>Schedules to act on</span>
                <strong>{evaluation.wedgedSchedules}</strong>
                <small>Overdue or holding an expired claim</small>
              </div>
            </section>
          </>
        ) : null}

        {fleet.instances.length === 0 ? (
          <EmptyState
            eyebrow="Fleet presence"
            title="No worker instance has reported"
            description="Presence records are written by running workers and pruned after their retention window. Nothing here means either no worker has started since this deployment or every record has aged out."
          />
        ) : (
          <WorkerInstanceLedger instances={fleet.instances} />
        )}
        {fleet.hasMore ? (
          <aside className="ops-independence-note">
            <strong>More instances exist.</strong>
            <p>
              The most recently seen instances are shown first. Older presence
              records stay readable until their retention window prunes them.
            </p>
          </aside>
        ) : null}
      </SectionState>

      <SectionState
        loading={stalled.loading}
        error={stalled.error}
        onRetry={stalled.reload}
        loadingLabel="Checking run heartbeats…"
      >
        {stalled.items.length === 0 ? (
          <EmptyState
            eyebrow="Run heartbeats"
            title={
              stalled.staleAfterMs === null
                ? "Stalled runs cannot be judged yet"
                : "No stalled runs"
            }
            description={
              stalled.staleAfterMs === null
                ? "No worker has published a run-heartbeat window, so no running import can be measured against one. The fleet state above is the fact to act on."
                : `Every running import has beaten inside its ${age(stalled.staleAfterMs)} window.`
            }
          />
        ) : (
          <StalledRunLedger runs={stalled.items} />
        )}
        <Pagination pagination={stalled.pagination} />
      </SectionState>

      <SectionState
        loading={schedules.loading}
        error={schedules.error}
        onRetry={schedules.reload}
        loadingLabel="Loading schedule health…"
      >
        {schedules.items.length === 0 ? (
          <EmptyState
            eyebrow="Provider scheduling"
            title="No provider is scheduled"
            description="Schedules appear once a tested provider is enabled for scheduled imports."
          />
        ) : (
          <ScheduleHealthLedger schedules={schedules.items} />
        )}
        <Pagination pagination={schedules.pagination} />
      </SectionState>

      <SectionState
        loading={settings.loading}
        error={settings.error}
        onRetry={settings.reload}
        loadingLabel="Loading effective worker settings…"
      >
        {settings.settings ? (
          <WorkerSettingsPanel
            resolution={settings.settings}
            observedAt={settings.observedAt}
          />
        ) : null}
      </SectionState>
    </div>
  );
}
