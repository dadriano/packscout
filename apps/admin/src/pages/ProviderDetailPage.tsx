import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ProviderConfigurationSummary } from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import { requestManualImport } from "../api/import-operations";
import {
  changeProviderLifecycle,
  getProvider,
  testProviderConnection,
  type ProviderHealthSummary,
} from "../api/providers";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge, type StatusTone } from "../components/StatusBadge";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function tone(value: string): StatusTone {
  if (["active", "fresh", "healthy", "success", "succeeded"].includes(value)) return "ready";
  if (["draft", "warning", "queued", "running"].includes(value)) return "pending";
  if (["disabled", "stale", "degraded", "failed", "authentication_failure", "contract_failure", "timeout", "unreachable", "http_failure", "invalid_json", "stale_test"].includes(value)) return "danger";
  return "neutral";
}

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function duration(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.code === "CONFIG_REVISION_CONFLICT") return "A newer configuration exists. Reload before trying this action again.";
    return error.message;
  }
  return "Provider operations are temporarily unavailable. No configuration was changed.";
}

export function ProviderDetailPage() {
  const { providerId = "" } = useParams();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { status } = useSession();
  const canManage = status.phase === "authenticated" && status.session.permissions.includes("providers:manage");
  const canStartImports = status.phase === "authenticated" && status.session.permissions.includes("imports:start");
  const [provider, setProvider] = useState<ProviderConfigurationSummary | null>(null);
  const [health, setHealth] = useState<ProviderHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadIndex, setReloadIndex] = useState(0);
  useDocumentTitle(provider?.displayName ?? "Data Provider");

  useEffect(() => {
    let active = true;
    void getProvider(providerId)
      .then((result) => {
        if (!active) return;
        setProvider(result.provider);
        setHealth(result.health);
        setError(null);
      })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [providerId, reloadIndex]);

  async function runTest(): Promise<void> {
    if (!provider) return;
    setTesting(true);
    setError(null);
    try {
      const { test } = await testProviderConnection(provider.id, provider.latestRevision.id);
      setProvider({
        ...provider,
        latestRevision: {
          ...provider.latestRevision,
          testedAt: test.checkedAt,
          lastConnectionTest: test,
        },
      });
      showToast(test.verdict === "success" ? "Connection test passed." : `Connection test returned ${label(test.verdict).toLowerCase()}.`, test.verdict === "success" ? "success" : "error");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setTesting(false);
    }
  }

  async function lifecycle(action: "activate" | "disable" | "archive"): Promise<void> {
    if (!provider) return;
    const actionLabel = action === "activate" ? "Enable" : action === "disable" ? "Disable" : "Archive";
    await confirm({
      tier: action === "activate" ? "standard" : "danger",
      title: `${actionLabel} ${provider.displayName}?`,
      description: action === "activate"
        ? "This tested revision becomes the source for scheduled imports on its platform."
        : action === "disable"
          ? "No new imports will start. An import already running is allowed to finish."
          : "This provider stays in history and cannot start new imports. Any active run is allowed to finish.",
      confirmLabel: `${actionLabel} provider`,
      successMessage: `${provider.displayName} ${action === "activate" ? "enabled" : action === "disable" ? "disabled" : "archived"}.`,
      action: async () => {
        const result = await changeProviderLifecycle(provider.id, action, provider.latestRevision.id);
        setProvider(result.provider);
      },
    });
  }

  async function startManualImport(): Promise<void> {
    if (!provider) return;
    await confirm({
      title: `Run import for ${provider.displayName}?`,
      description: `${provider.platformKey} active configuration ${provider.activeRevisionId?.slice(0, 8) ?? "unavailable"} will start from its durable cursor. Only one queued or running import is allowed for this provider.`,
      confirmLabel: "Run import",
      action: async () => {
        const result = await requestManualImport(provider.id, provider.activeRevisionId ?? provider.latestRevision.id);
        showToast(result.deduplicated
          ? "An import is already in progress. We opened the active run."
          : "Manual import requested.");
        navigate(`/runs/${result.run.id}`);
      },
    });
  }

  if (loading) return <div className="provider-loading" aria-busy="true">Loading provider and health…</div>;
  if (!provider || !health) {
    return <div className="provider-load-error" role="alert"><p>{error ?? "Provider not found."}</p><Link className="admin-button admin-button--secondary" to="/providers">Return to providers</Link></div>;
  }

  const revision = provider.latestRevision;
  const test = revision.lastConnectionTest;
  const enableReady = test?.verdict === "success";
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow={`Data providers / ${provider.platformKey}`}
        title={provider.displayName}
        description={`Revision ${revision.version} · ${revision.adapterKey} · ${revision.endpointHost}`}
        actions={<Link className="admin-button admin-button--secondary" to="/providers">All providers</Link>}
      />

      {!canManage ? <aside className="provider-read-only-note"><strong>Read-only access</strong><p>Credential contents and configuration controls are restricted. Stored credentials remain masked.</p></aside> : null}
      {error ? <div className="provider-load-error" role="alert"><p>{error}</p><button type="button" className="admin-button admin-button--secondary" onClick={() => setReloadIndex((value) => value + 1)}>Reload current state</button></div> : null}

      <section className="provider-detail-status" aria-label="Provider status">
        <StatusBadge label={label(provider.state)} tone={tone(provider.state)} />
        <StatusBadge label={label(health.freshnessState)} tone={tone(health.freshnessState)} />
        <StatusBadge label={`${label(health.qualityState)} quality`} tone={tone(health.qualityState)} />
        {health.activeRun ? <StatusBadge label={`Run ${label(health.activeRun.state)}`} tone="pending" /> : null}
      </section>

      {canStartImports ? (
        <section className="provider-actions" aria-labelledby="provider-import-actions-title">
          <div><span className="admin-eyebrow">Import operations</span><h2 id="provider-import-actions-title">Manual import</h2><p>Manual and scheduled imports share one active-run limit and the same durable cursor.</p></div>
          <div>
            <Link className="admin-button admin-button--secondary" to={`/runs?providerId=${provider.id}`}>Run history</Link>
            {health.openQuarantineCount > 0 ? <Link className="admin-button admin-button--secondary" to={`/quarantine?providerId=${provider.id}&state=open`}>Review quarantine ({health.openQuarantineCount})</Link> : null}
            {health.activeRun ? <Link className="admin-button admin-button--primary" to={`/runs/${health.activeRun.id}`}>Open active run</Link> : <button type="button" className="admin-button admin-button--primary" disabled={provider.state !== "active"} title={provider.state !== "active" ? "Enable the tested provider before requesting an import." : undefined} onClick={() => void startManualImport()}>Run import</button>}
          </div>
          {health.activeRun ? <p className="provider-actions__gate">A {health.activeRun.state} import already owns this provider. Open it instead of starting duplicate work.</p> : null}
        </section>
      ) : null}

      {canManage ? (
        <section className="provider-actions" aria-labelledby="provider-actions-title">
          <div><span className="admin-eyebrow">Administrator controls</span><h2 id="provider-actions-title">Test before enablement</h2><p>A successful test is required for this exact revision. Changes never overwrite revision history.</p></div>
          <div>
            {provider.state !== "archived" ? <Link className="admin-button admin-button--secondary" to={`/providers/${provider.id}/edit`}>Create revision</Link> : null}
            {provider.state !== "archived" ? <button type="button" className="admin-button admin-button--secondary" disabled={testing} onClick={() => void runTest()}>{testing ? "Testing…" : "Test connection"}</button> : null}
            {provider.state !== "active" && provider.state !== "archived" ? <button type="button" className="admin-button admin-button--primary" disabled={!enableReady} title={!enableReady ? "Run a successful connection test for this revision first." : undefined} onClick={() => void lifecycle("activate")}>Enable provider</button> : null}
            {provider.state === "active" ? <button type="button" className="admin-button admin-button--danger" onClick={() => void lifecycle("disable")}>Disable provider</button> : null}
            {provider.state === "disabled" ? <button type="button" className="admin-button admin-button--danger" onClick={() => void lifecycle("archive")}>Archive provider</button> : null}
          </div>
          {!enableReady && provider.state !== "active" && provider.state !== "archived" ? <p className="provider-actions__gate">Enablement is locked until this revision passes its connection test.</p> : null}
        </section>
      ) : null}

      <div className="provider-detail-grid">
        <section className="provider-detail-card" aria-labelledby="provider-config-title">
          <header><span className="admin-eyebrow">Masked settings</span><h2 id="provider-config-title">Configuration</h2></header>
          <dl>
            <div><dt>Platform</dt><dd>{provider.platformKey}</dd></div>
            <div><dt>Adapter</dt><dd>{revision.adapterKey}</dd></div>
            <div><dt>Endpoint host</dt><dd>{revision.endpointHost}</dd></div>
            <div><dt>Authentication</dt><dd>{revision.authMode === "bearer" ? (revision.hasBearerSecret ? "Bearer · credential configured" : "Bearer · credential missing") : "None"}</dd></div>
            <div><dt>Schedule</dt><dd>Every {duration(revision.scheduleSeconds)}</dd></div>
            <div><dt>Stale threshold</dt><dd>{duration(revision.staleAfterSeconds)}</dd></div>
            <div><dt>Active revision</dt><dd>{provider.activeRevisionId === revision.id ? `Revision ${revision.version}` : "Earlier or none"}</dd></div>
          </dl>
        </section>
        <section className="provider-detail-card" aria-labelledby="provider-health-title">
          <header><span className="admin-eyebrow">Operational evidence</span><h2 id="provider-health-title">Health</h2></header>
          <dl>
            <div><dt>Last provider head</dt><dd>{dateTime(health.lastHeadReachedAt)}</dd></div>
            <div><dt>Next due</dt><dd>{dateTime(health.nextDueAt)}</dd></div>
            <div><dt>Latest run</dt><dd>{health.latestRun ? <Link to={`/runs/${health.latestRun.id}`}>{label(health.latestRun.state)}</Link> : "No runs"}</dd></div>
            <div><dt>Open quarantine</dt><dd>{health.openQuarantineCount}</dd></div>
            <div><dt>Consecutive failures</dt><dd>{health.consecutiveFailures}</dd></div>
            <div><dt>Recovery</dt><dd>{health.recoveryHint}</dd></div>
          </dl>
        </section>
      </div>

      <section className="provider-test-result" aria-labelledby="provider-test-title" aria-live="polite">
        <header><span className="admin-eyebrow">Revision {revision.version}</span><h2 id="provider-test-title">Latest connection test</h2></header>
        {test ? <div><StatusBadge label={label(test.verdict)} tone={tone(test.verdict)} /><p>Checked {dateTime(test.checkedAt)} · {test.latencyMs} ms{test.responseStatus ? ` · HTTP ${test.responseStatus}` : ""}</p>{test.recordCounts ? <p>{test.recordCounts.catalog} catalog · {test.recordCounts.pulls} pulls · {test.recordCounts.trades} trades</p> : null}{test.sanitizedCode ? <code>{test.sanitizedCode}</code> : null}</div> : <p>No connection test has been recorded for this revision.</p>}
      </section>
    </div>
  );
}
