import {
  DATA_RELEASE_SCHEMA_VERSION,
  PRODUCTION_AUTH_SHA256_PATTERN,
  productionActiveStateReceiptSchema,
  productionActiveStateRequestSchema,
  productionReceiptSchema,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import { productionReceiptHash } from "./productionDataReleaseProtocol";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
} as const;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Utf8(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )));
}

async function activeStateReceipt(input: {
  operationId: string;
  requestDigest: string;
  activePublicReleaseId: string | null;
  observationSequence: number;
  terminalReceiptSha256: string | null;
}) {
  const receiptWithoutDigest = {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: input.operationId,
    operationKind: "activeState" as const,
    publicationId: input.activePublicReleaseId,
    terminalState: "observed" as const,
    result: "active_state" as const,
    serverTime: new Date().toISOString(),
    requestDigest: input.requestDigest,
    details: {
      activePublicReleaseId: input.activePublicReleaseId,
      observationSequence: input.observationSequence,
      terminalReceiptSha256: input.terminalReceiptSha256,
    },
  };
  return productionActiveStateReceiptSchema.parse({
    ...receiptWithoutDigest,
    receiptDigest: await productionReceiptHash(receiptWithoutDigest),
  });
}

export const activeState = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!PRODUCTION_AUTH_SHA256_PATTERN.test(args.requestDigest)) {
      refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
    }
    let body: unknown;
    try {
      body = JSON.parse(args.bodyJson) as unknown;
    } catch {
      refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
    }
    const request = productionActiveStateRequestSchema.safeParse(body);
    if (!request.success) {
      refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
    }

    const states = await ctx.db
      .query("dataReleaseState")
      .withIndex("by_key", (index) => index.eq("key", "singleton"))
      .take(2);
    if (states.length === 0) {
      return await activeStateReceipt({
        operationId: request.data.operationId,
        requestDigest: args.requestDigest,
        activePublicReleaseId: null,
        observationSequence: 0,
        terminalReceiptSha256: null,
      });
    }
    if (states.length !== 1 || states[0]!.activeReleaseId === null) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const state = states[0]!;
    const release = await ctx.db.get("dataReleases", state.activeReleaseId!);
    if (
      release === null ||
      release.lifecycle !== "complete" ||
      release.publicReleaseId !== release.metadata.publicReleaseId ||
      !Number.isSafeInteger(state.latestObservationSequence) ||
      state.latestObservationSequence <= 0
    ) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }

    const [finalize, refresh] = await Promise.all([
      ctx.db
        .query("dataReleaseOperations")
        .withIndex("by_public_release_id_and_kind", (index) =>
          index
            .eq("publicReleaseId", release.publicReleaseId)
            .eq("kind", "finalize"),
        )
        .order("desc")
        .take(1),
      ctx.db
        .query("dataReleaseOperations")
        .withIndex("by_public_release_id_and_kind", (index) =>
          index
            .eq("publicReleaseId", release.publicReleaseId)
            .eq("kind", "refreshObservation"),
        )
        .order("desc")
        .take(1),
    ]);
    const candidates = [...finalize, ...refresh]
      .filter((operation) =>
        operation.status === "completed" &&
        operation.observationSequence === state.latestObservationSequence &&
        operation.receiptJson !== undefined,
      );
    if (candidates.length !== 1) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const operation = candidates[0]!;
    let storedReceipt: unknown;
    try {
      storedReceipt = JSON.parse(operation.receiptJson!) as unknown;
    } catch {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const receipt = productionReceiptSchema.safeParse(storedReceipt);
    if (
      !receipt.success ||
      receipt.data.publicationId !== release.publicReleaseId ||
      receipt.data.operationId !== operation.operationId ||
      receipt.data.requestDigest !== operation.bodyHash ||
      (receipt.data.operationKind !== "finalize" &&
        receipt.data.operationKind !== "refreshObservation")
    ) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    return await activeStateReceipt({
      operationId: request.data.operationId,
      requestDigest: args.requestDigest,
      activePublicReleaseId: release.publicReleaseId,
      observationSequence: state.latestObservationSequence,
      terminalReceiptSha256: await sha256Utf8(operation.receiptJson!),
    });
  },
});
