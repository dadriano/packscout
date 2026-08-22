import { useCallback, useEffect, useState } from "react";
import type {
  CreateProviderSourceRequest,
  CreateSourceConnectionProfileRequest,
  ProviderSourceAdminCatalog,
  ProviderSourceAdminSummary,
  ReplaceProviderSourceRequest,
  SourceConnectionProfileAdminSummary,
} from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import {
  activateSourceConnectionRevision,
  activateSourceConnectionRecovery,
  commandProviderSource,
  createProviderSource,
  createSourceConnectionProfile,
  createSourceConnectionRecoveryRevision,
  getProviderSourceCatalog,
  previewProviderSourceCheckpointReset,
  replaceProviderSource,
  resetProviderSourceCheckpoint,
  requestSourceConnectionTest,
  requestSourceConnectionRecoveryTest,
  reviseProviderSourceInterval,
  revokeSourceConnectionRevision,
  rotateSourceConnectionCredential,
} from "../api/provider-sources";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import {
  ProviderSourceLedger,
  SourceConnectionLedger,
} from "../components/source-configuration/SourceConfigurationLedgers";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

function errorMessage(error: unknown): string {
  if (!(error instanceof AdminApiError)) {
    return "Source administration is temporarily unavailable. No configuration was changed.";
  }
  if (error.status === 403) return "Your role cannot change this source configuration.";
  if (error.code === "SOURCE_CONFLICT") {
    return "This source changed in another session. Reload its current revision before trying again.";
  }
  if (error.code === "SOURCE_TEST_REQUIRED") {
    return "A current successful connection and source test is required before activation.";
  }
  if (error.code === "SOURCE_DEPENDENCY_REQUIRED") {
    return "The shared connection requires recovery before this command can continue.";
  }
  if (error.code === "INVALID_SOURCE_CONFIGURATION") {
    return "Check the selected source, interval, and credential values, then try again.";
  }
  return error.message;
}

export function SourceConfigurationPage() {
  useDocumentTitle("Source Configuration");
  const { status } = useSession();
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const canView = status.phase === "authenticated" &&
    status.session.permissions.includes("providers:view");
  const canManage = status.phase === "authenticated" &&
    status.session.permissions.includes("providers:manage");
  const canManageSecrets = status.phase === "authenticated" &&
    status.session.permissions.includes("provider_secrets:manage");
  const [catalog, setCatalog] = useState<ProviderSourceAdminCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadIndex, setLoadIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await getProviderSourceCatalog();
    setCatalog(result.catalog);
    setLoadError(null);
  }, []);

  useEffect(() => {
    if (!canView) return;
    let active = true;
    void getProviderSourceCatalog()
      .then((result) => {
        if (!active) return;
        setCatalog(result.catalog);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [canView, loadIndex]);

  async function mutate(
    key: string,
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> {
    setPendingKey(key);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      await reload();
      setNotice(success);
      showToast(success);
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
    } finally {
      setPendingKey(null);
    }
  }

  function connectionCommand(
    action: "test" | "activate" | "revoke" | "recovery-test" | "recovery-activate",
    connection: SourceConnectionProfileAdminSummary,
  ) {
    const revisionId = connection.latestRevision.id;
    if (action === "revoke") {
      void confirm({
        tier: "danger-typed",
        typedAcknowledgment: "REVOKE",
        title: `Revoke ${connection.displayName}?`,
        description: "Only work pinned to this revision will be fenced. Committed provider checkpoints are preserved.",
        confirmLabel: "Revoke revision",
        action: async () => {
          await revokeSourceConnectionRevision(connection.id, revisionId);
          await reload();
          setNotice("Connection revision revoked; affected work is fenced.");
        },
        successMessage: "Connection revision revoked.",
      });
      return;
    }
    if (action === "recovery-test" || action === "recovery-activate") {
      const fence = connection.recoveryFence;
      if (!fence) return;
      const recoveryInput = {
        expectedRevisionId: revisionId,
        expectedHealthGeneration: connection.latestRevision.healthGeneration,
        blockedRevisionId: fence.blockedRevisionId,
        blockingEpisodeId: fence.blockingEpisodeId,
      };
      void mutate(
        `connection:${connection.id}:${action}`,
        action === "recovery-test"
          ? () => requestSourceConnectionRecoveryTest(connection.id, recoveryInput)
          : () => activateSourceConnectionRecovery(connection.id, recoveryInput),
        action === "recovery-test"
          ? "Recovery test requested against the exact blocked connection fence."
          : "Recovery activated; old-revision work was fenced and eligible sources were queued from committed checkpoints.",
      );
      return;
    }
    const request = action === "test"
      ? () => requestSourceConnectionTest(connection.id, revisionId)
      : () => activateSourceConnectionRevision(connection.id, revisionId);
    void mutate(
      `connection:${connection.id}:${action}`,
      request,
      action === "test"
        ? "Connection test requested. It remains pending until the supervisor runs it."
        : "Tested connection revision activated for new runs.",
    );
  }

  function sourceCommand(
    action: "test" | "activate" | "pause" | "resume" | "disable" | "reset",
    source: ProviderSourceAdminSummary,
  ) {
    if (action === "reset") {
      void previewReset(source);
      return;
    }
    if (action === "disable") {
      void confirm({
        tier: "danger",
        title: `Disable ${source.provider}?`,
        description: "Future work will stop. A new current test and explicit activation are required before this source can resume.",
        confirmLabel: "Disable source",
        action: async () => {
          await commandProviderSource(
            source.providerId,
            source.sourceInstanceId,
            "disable",
            source.sourceRevisionId,
          );
          await reload();
          setNotice(`${source.provider} source disabled.`);
        },
        successMessage: "Source disabled.",
      });
      return;
    }
    void mutate(
      `source:${source.sourceInstanceId}:${action}`,
      () => commandProviderSource(
        source.providerId,
        source.sourceInstanceId,
        action,
        source.sourceRevisionId,
        source.connectionRevisionId ?? undefined,
      ),
      action === "test"
        ? "Source test requested. It remains pending until the supervisor runs it."
        : action === "activate"
          ? "Tested source activated in paused state. Resume when ingestion should begin."
          : action === "pause"
            ? "Pause requested. The current page may commit, but no next page or queued run will start."
            : action === "resume"
              ? `Source resumed from ${source.checkpoint.resumeLabel}.`
              : "Source command completed.",
    );
  }

  async function previewReset(source: ProviderSourceAdminSummary) {
    setPendingKey(`source:${source.sourceInstanceId}:reset-preview`);
    setActionError(null);
    try {
      const { preview } = await previewProviderSourceCheckpointReset(
        source.providerId,
        source.sourceInstanceId,
        source.sourceRevisionId,
      );
      await confirm({
        tier: "danger-typed",
        typedAcknowledgment: preview.confirmation,
        title: `Reset ${preview.provider} checkpoint?`,
        description: `${preview.consequence} Current generation: ${preview.checkpointGeneration}. Current fingerprint: ${preview.checkpointFingerprint ?? "none"}.`,
        confirmLabel: "Reset checkpoint",
        action: async () => {
          await resetProviderSourceCheckpoint(
            preview.providerId,
            preview.sourceInstanceId,
            {
              expectedSourceRevisionId: preview.sourceRevisionId,
              expectedCheckpointGeneration: preview.checkpointGeneration,
              expectedCheckpointFingerprint: preview.checkpointFingerprint,
              confirmation: preview.confirmation,
            },
          );
          await reload();
          setNotice(`${preview.provider} checkpoint reset to Feed start with a new generation.`);
        },
        successMessage: "Checkpoint reset completed.",
      });
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingKey(null);
    }
  }

  if (!canView) {
    return (
      <EmptyState
        eyebrow="Access restricted"
        title="Source configuration is not available for this role"
        description="Provider viewing permission is required. No configuration has been exposed or changed."
      />
    );
  }

  return (
    <div className="admin-page source-config-page">
      <PageHeader
        eyebrow="Data pipeline / Source configuration"
        title="Source configuration"
        description="Bind one masked shared connection to isolated provider sources, then test and activate each immutable revision."
      />

      {!canManage ? (
        <aside className="source-config-note">
          <strong>Read-only source evidence</strong>
          <p>You can inspect masked connection, adapter, mapper, timing, test, and checkpoint state. Configuration authority remains administrator-only.</p>
        </aside>
      ) : null}
      {loading ? (
        <div className="ops-loading" aria-live="polite" aria-busy="true">
          Loading masked source configuration…
        </div>
      ) : null}
      {loadError ? (
        <div className="ops-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="admin-button admin-button--secondary"
            onClick={() => {
              setLoading(true);
              setLoadIndex((value) => value + 1);
            }}>Try again</button>
        </div>
      ) : null}
      <div className="source-config-announcer" aria-live="polite" aria-atomic="true">
        {actionError ? <p className="admin-inline-error" role="alert">{actionError}</p> : null}
        {notice ? <p className="source-config-success">{notice}</p> : null}
      </div>
      {!loading && !loadError && catalog ? (
        <>
          {catalog.connections.length === 0 && !canManageSecrets ? (
            <EmptyState title="No shared connection is configured"
              description="An administrator with secret authority must add and test the first DataForrest profile." />
          ) : null}
          <SourceConnectionLedger
            connections={catalog.connections}
            canManage={canManage}
            canManageSecrets={canManageSecrets}
            pendingKey={pendingKey}
            onCreate={(request: CreateSourceConnectionProfileRequest) =>
              mutate("connection:create", () => createSourceConnectionProfile(request),
                "Inactive connection profile saved. Request a test before activation.")}
            onRotate={(connection, bearerCredential) => mutate(
              `connection:${connection.id}:rotate`,
              () => rotateSourceConnectionCredential(connection.id, {
                expectedRevisionId: connection.latestRevision.id,
                bearerCredential,
              }),
              "Candidate credential revision saved. Existing runs keep their pinned revision.",
            )}
            onRecover={(connection, bearerCredential) => {
              const fence = connection.recoveryFence;
              if (!fence) return Promise.resolve(false);
              return mutate(
                `connection:${connection.id}:recovery-revision`,
                () => createSourceConnectionRecoveryRevision(connection.id, {
                  expectedBlockedRevisionId: fence.blockedRevisionId,
                  expectedLatestRevisionId: connection.latestRevision.id,
                  blockingEpisodeId: fence.blockingEpisodeId,
                  bearerCredential,
                }),
                "Recovery candidate saved. Run the exact recovery test before activation.",
              );
            }}
            onCommand={connectionCommand}
          />
          {catalog.providers.length === 0 ? (
            <EmptyState title="No stable providers are available"
              description="Create the stable provider records before binding DataForrest sources." />
          ) : (
            <ProviderSourceLedger
              catalog={catalog}
              canManage={canManage}
              pendingKey={pendingKey}
              onCreate={(request: CreateProviderSourceRequest | ReplaceProviderSourceRequest,
                replacement: boolean) => {
                if (!replacement) {
                  return mutate(
                    "source:create",
                    () => createProviderSource(request as CreateProviderSourceRequest),
                    "Inactive source created with its approved mapper and a null checkpoint.",
                  );
                }
                const replacementRequest = request as ReplaceProviderSourceRequest;
                const selectedProvider = catalog.providers.find(
                  (provider) => provider.id === replacementRequest.providerId,
                );
                const previous = catalog.sources.find(
                  (source) => source.sourceInstanceId ===
                    replacementRequest.replacesSourceInstanceId,
                );
                const providerLabel = selectedProvider?.provider.replaceAll("_", " ") ??
                  "selected provider";
                return confirm({
                  tier: "danger",
                  title: `Replace ${providerLabel} source?`,
                  description: `Only ${providerLabel} is affected. The ${previous?.state ?? "inactive"} source stays in history, but its checkpoint cannot transfer. The replacement starts at Feed start and must be tested; activation begins paused until an operator resumes it.`,
                  confirmLabel: "Replace selected source",
                  action: async () => {
                    await replaceProviderSource(replacementRequest);
                    await reload();
                    setNotice(`Replacement for ${providerLabel} created at Feed start; prior history was retained.`);
                  },
                  successMessage: `Replacement for ${providerLabel} created.`,
                });
              }}
              onCommand={sourceCommand}
              onInterval={(source, intervalSeconds) => mutate(
                `source:${source.sourceInstanceId}:interval`,
                () => reviseProviderSourceInterval(
                  source.providerId,
                  source.sourceInstanceId,
                  {
                    expectedSourceRevisionId: source.sourceRevisionId,
                    expectedScheduleRevisionId: source.scheduleRevisionId,
                    intervalSeconds,
                  },
                ),
                "Timing revision saved. Current work and checkpoint were preserved.",
              )}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
