import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseCompletedHeadRequestSchema,
  providerReleaseStatusNotFoundReceiptSchema,
  providerReleaseStatusRequestSchema,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  buildProviderReleaseReceipt,
  loadProviderStatusReceipt,
} from "./providerReleaseOperations";
import {
  assertProviderRequestDigest,
  assertProviderPlatformAuthority,
  parseProviderReleaseRequest,
} from "./providerReleaseRequests";
import { providerCompletedHeadState } from "./providerReleaseState";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

export const completedHead = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseCompletedHeadRequestSchema,
    );
    assertProviderPlatformAuthority(args.authenticatedKeyId, request.platformKey);
    const head = await providerCompletedHeadState(ctx, request.platformKey);
    return await buildProviderReleaseReceipt(
      (value) => providerReleaseCompletedHeadReceiptSchema.parse(value),
      {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationKind: "completedHead",
        operationId: request.operationId,
        platformKey: request.platformKey,
        publicProviderReleaseId:
          head.release?.publicProviderReleaseId ?? null,
        terminalState: "observed",
        result: "completed_head",
        serverTime: new Date().toISOString(),
        requestDigest: args.requestDigest,
        details: { head },
      },
    );
  },
});

export const status = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseStatusRequestSchema,
    );
    assertProviderPlatformAuthority(
      args.authenticatedKeyId,
      request.target.platformKey,
    );
    const stored = await loadProviderStatusReceipt(ctx, request.target);
    return stored ?? providerReleaseStatusNotFoundReceiptSchema.parse({
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      target: request.target,
      terminalState: "not_found",
      result: "not_found",
      serverTime: new Date().toISOString(),
      requestDigest: request.target.requestDigest,
      details: {},
      receiptDigest: null,
    });
  },
});
