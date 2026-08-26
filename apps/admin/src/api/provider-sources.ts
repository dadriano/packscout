import type {
  ConfirmProviderSourceCursorResetRequest,
  CreateProviderSourceRequest,
  CreateSourceConnectionProfileRequest,
  CreateSourceConnectionRecoveryRevisionRequest,
  ProviderSourceAdminAuditReceipt,
  ProviderSourceAdminCatalog,
  ProviderSourceCursorResetPreview,
  ReviseProviderSourceIntervalRequest,
  RotateSourceConnectionCredentialRequest,
} from "@packscout/contracts";
import { requestJson } from "./client";

export function getProviderSourceCatalog(): Promise<{
  catalog: ProviderSourceAdminCatalog;
}> {
  return requestJson("/provider-sources");
}

export function createSourceConnectionProfile(
  input: CreateSourceConnectionProfileRequest,
) {
  return requestJson<{
    profileId: string;
    revisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>("/provider-sources/connections", { method: "POST", json: input });
}

export function rotateSourceConnectionCredential(
  connectionProfileId: string,
  input: RotateSourceConnectionCredentialRequest,
) {
  return requestJson<{
    profileId: string;
    revisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>(`/provider-sources/connections/${encodeURIComponent(connectionProfileId)}/rotate`, {
    method: "POST",
    json: input,
  });
}

export function requestSourceConnectionTest(
  connectionProfileId: string,
  expectedRevisionId: string,
) {
  return connectionCommand(connectionProfileId, "test", expectedRevisionId);
}

export function activateSourceConnectionRevision(
  connectionProfileId: string,
  expectedRevisionId: string,
) {
  return connectionCommand(connectionProfileId, "activate", expectedRevisionId);
}

function connectionCommand(
  connectionProfileId: string,
  action: "test" | "activate",
  expectedRevisionId: string,
) {
  return requestJson<{
    jobId?: string;
    state?: "pending";
    audit: ProviderSourceAdminAuditReceipt;
  }>(`/provider-sources/connections/${encodeURIComponent(connectionProfileId)}/${action}`, {
    method: "POST",
    json: { expectedRevisionId },
  });
}

export function revokeSourceConnectionRevision(
  connectionProfileId: string,
  expectedRevisionId: string,
) {
  return requestJson<{ audit: ProviderSourceAdminAuditReceipt }>(
    `/provider-sources/connections/${encodeURIComponent(connectionProfileId)}/revoke`,
    {
      method: "POST",
      json: { expectedRevisionId, confirmation: "REVOKE" },
    },
  );
}

export function createSourceConnectionRecoveryRevision(
  connectionProfileId: string,
  input: CreateSourceConnectionRecoveryRevisionRequest,
) {
  return requestJson<{
    profileId: string;
    revisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>(`/provider-sources/connections/${encodeURIComponent(connectionProfileId)}/recovery-revision`, {
    method: "POST",
    json: input,
  });
}

export function requestSourceConnectionRecoveryTest(
  connectionProfileId: string,
  input: Readonly<{
    expectedRevisionId: string;
    expectedHealthGeneration: string;
    blockedRevisionId: string;
    blockingEpisodeId: string | null;
  }>,
) {
  return requestJson<{
    jobId: string;
    state: "pending";
    audit: ProviderSourceAdminAuditReceipt;
  }>(`/provider-sources/connections/${encodeURIComponent(connectionProfileId)}/recovery-test`, {
    method: "POST",
    json: input,
  });
}

export function activateSourceConnectionRecovery(
  connectionProfileId: string,
  input: Readonly<{
    expectedRevisionId: string;
    expectedHealthGeneration: string;
    blockedRevisionId: string;
    blockingEpisodeId: string | null;
  }>,
) {
  return requestJson<{
    runIds: readonly string[];
    audit: ProviderSourceAdminAuditReceipt;
  }>(`/provider-sources/connections/${encodeURIComponent(connectionProfileId)}/recovery-activate`, {
    method: "POST",
    json: input,
  });
}

export function createProviderSource(input: CreateProviderSourceRequest) {
  return requestJson<{
    sourceInstanceId: string;
    sourceRevisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>("/provider-sources/sources", { method: "POST", json: input });
}

function sourcePath(providerId: string, sourceInstanceId: string, action: string) {
  return `/provider-sources/providers/${encodeURIComponent(providerId)}/sources/${encodeURIComponent(sourceInstanceId)}/${action}`;
}

export function commandProviderSource(
  providerId: string,
  sourceInstanceId: string,
  action: "test" | "activate" | "pause" | "resume" | "disable",
  expectedSourceRevisionId: string,
  expectedConnectionRevisionId?: string,
) {
  return requestJson<{
    jobId?: string;
    state?: "pending" | "paused" | "pause_requested" | "resumed";
    audit: ProviderSourceAdminAuditReceipt;
  }>(sourcePath(providerId, sourceInstanceId, action), {
    method: "POST",
    json: {
      expectedSourceRevisionId,
      ...(expectedConnectionRevisionId ? { expectedConnectionRevisionId } : {}),
    },
  });
}

export function reviseProviderSourceInterval(
  providerId: string,
  sourceInstanceId: string,
  input: ReviseProviderSourceIntervalRequest,
) {
  return requestJson<{
    scheduleRevisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>(sourcePath(providerId, sourceInstanceId, "interval"), {
    method: "POST",
    json: input,
  });
}

export function previewProviderSourceCursorReset(
  providerId: string,
  sourceInstanceId: string,
  expectedSourceRevisionId: string,
) {
  return requestJson<{ preview: ProviderSourceCursorResetPreview }>(
    sourcePath(providerId, sourceInstanceId, "cursor-reset-preview"),
    { method: "POST", json: { expectedSourceRevisionId } },
  );
}

export function resetProviderSourceCursor(
  providerId: string,
  sourceInstanceId: string,
  input: ConfirmProviderSourceCursorResetRequest,
) {
  return requestJson<{
    cursorGeneration: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>(sourcePath(providerId, sourceInstanceId, "cursor-reset"), {
    method: "POST",
    json: input,
  });
}
