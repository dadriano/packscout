export interface CatalogPromotionBootstrapProofRow {
  proofRevision: bigint;
  proofKind: "empty" | "cleared" | "active";
  providerSetBody: string;
  providerSetSha256: string;
  activeStateRequestBody: string;
  activeStateRequestSha256: string;
  activeStateReceiptBody: string;
  activeStateReceiptSha256: string;
  activeStateResponseBody: string | null;
  activeStateResponseSha256: string | null;
  manifestDefinitionRequestBody: string | null;
  manifestDefinitionRequestSha256: string | null;
  manifestTerminalRequestBody: string | null;
  manifestTerminalRequestSha256: string | null;
  manifestReceiptBody: string | null;
  manifestReceiptSha256: string | null;
  manifestResponseBody: string | null;
  manifestResponseSha256: string | null;
  activeStateBody: string;
  activeStateSha256: string;
  verifiedAt: Date;
}

export interface CatalogPromotionBootstrapProviderProofRow {
  ordinal: number;
  platformKey: string;
  publicProviderReleaseId: string | null;
  providerReleaseFingerprint: string | null;
  providerTerminalOperationId: string | null;
  providerTerminalReceiptBody: string | null;
  providerTerminalReceiptSha256: string | null;
  providerTerminalResponseBody: string | null;
  providerTerminalResponseSha256: string | null;
  publishArtifactAttemptId: string | null;
  completedHeadRequestBody: string;
  completedHeadRequestSha256: string;
  completedHeadReceiptBody: string;
  completedHeadReceiptSha256: string;
  completedHeadResponseBody: string | null;
  completedHeadResponseSha256: string | null;
  remoteCompletedHeadBody: string;
  remoteCompletedHeadSha256: string;
  localCompletedAttemptId: string | null;
  localCompletedPublicProviderReleaseId: string | null;
  localCompletedProviderReleaseFingerprint: string | null;
  localCompletedTerminalReceiptSha256: string | null;
}
