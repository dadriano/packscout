import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActiveStateRequestSchema,
  catalogManifestStatusNotFoundReceiptSchema,
  catalogManifestStatusRequestSchema,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  buildCatalogManifestReceipt,
  loadCatalogManifestStatusReceipt,
} from "./catalogManifestOperations";
import {
  assertCatalogManifestRequestDigest,
  assertCatalogManifestRole,
  parseCatalogManifestRequest,
} from "./catalogManifestRequests";
import {
  loadActiveCatalogManifestState,
  loadValidatedCatalogManifest,
} from "./catalogManifestState";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

export const activeState = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogManifestRequestDigest(args.requestDigest);
    assertCatalogManifestRole(args.authenticatedKeyId, "publish");
    const request = parseCatalogManifestRequest(
      args.bodyJson,
      catalogManifestActiveStateRequestSchema,
    );
    const stored = await loadActiveCatalogManifestState(ctx);
    if (stored.state.activeManifest !== null) {
      await loadValidatedCatalogManifest(ctx);
    }
    return await buildCatalogManifestReceipt(
      (value) => catalogManifestActiveStateReceiptSchema.parse(value),
      {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationKind: "activeState",
        operationId: request.operationId,
        terminalState: "observed",
        result: "active_state",
        serverTime: new Date().toISOString(),
        requestDigest: args.requestDigest,
        details: { activeState: stored.state },
      },
    );
  },
});

export const status = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogManifestRequestDigest(args.requestDigest);
    assertCatalogManifestRole(args.authenticatedKeyId, "publish");
    const request = parseCatalogManifestRequest(
      args.bodyJson,
      catalogManifestStatusRequestSchema,
    );
    const stored = await loadCatalogManifestStatusReceipt(ctx, request.target);
    return stored ?? catalogManifestStatusNotFoundReceiptSchema.parse({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
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
