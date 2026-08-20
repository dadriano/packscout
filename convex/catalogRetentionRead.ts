import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  catalogRetentionStatusNotFoundReceiptSchema,
  catalogRetentionStatusRequestSchema,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { loadCatalogRetentionStatusReceipt } from
  "./catalogRetentionOperations";
import {
  assertCatalogRetentionRequestDigest,
  assertCatalogRetentionRole,
  parseCatalogRetentionRequest,
} from "./catalogRetentionRequests";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

export const status = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogRetentionRequestDigest(args.requestDigest);
    assertCatalogRetentionRole(args.authenticatedKeyId);
    const request = parseCatalogRetentionRequest(
      args.bodyJson,
      catalogRetentionStatusRequestSchema,
    );
    const stored = await loadCatalogRetentionStatusReceipt(ctx, request.target);
    if (stored !== null) return stored;
    return catalogRetentionStatusNotFoundReceiptSchema.parse({
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
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
