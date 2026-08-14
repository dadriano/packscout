import type { ProviderStreamRecordV2 } from "@packscout/contracts";
import { hashJson } from "./security.ts";

export type ProviderStreamWriteDecisionV2 =
  | {
      readonly kind: "accept_initial";
      readonly contentHash: string;
    }
  | {
      readonly kind: "duplicate";
      readonly contentHash: string;
    }
  | {
      readonly kind: "catalog_revision";
      readonly previousContentHash: string;
      readonly contentHash: string;
    }
  | {
      readonly kind: "quarantine";
      readonly reasonCode:
        | "CATALOG_IDENTITY_CONFLICT"
        | "IMMUTABLE_EVENT_CONFLICT"
        | "SOURCE_IDENTITY_MISMATCH";
    };

export function providerStreamRecordIdentityHashV2(
  record: ProviderStreamRecordV2,
): string {
  return hashJson(
    record.stream === "catalog"
      ? {
          stream: record.stream,
          platform: record.platform,
          recordId: record.record_id,
          entity: record.entity,
          firstSeenAt: record.first_seen_at,
        }
      : {
          stream: record.stream,
          platform: record.platform,
          recordId: record.record_id,
        },
  );
}

/**
 * Observation time is deliberately excluded. Re-observing unchanged source
 * facts records an observation but must not manufacture a new catalog revision
 * or immutable-event conflict solely because collection happened later.
 */
export function providerStreamSourceFactsHashV2(
  record: ProviderStreamRecordV2,
): string {
  const sourceFacts = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "collected_at"),
  );
  return hashJson(sourceFacts);
}

export function providerStreamContentHashV2(record: ProviderStreamRecordV2): string {
  return hashJson(record);
}

export function decideProviderStreamWriteV2(input: {
  readonly existing: ProviderStreamRecordV2 | null;
  readonly incoming: ProviderStreamRecordV2;
}): ProviderStreamWriteDecisionV2 {
  const nextHash = providerStreamSourceFactsHashV2(input.incoming);
  if (input.existing === null) {
    return Object.freeze({ kind: "accept_initial", contentHash: nextHash });
  }
  if (
    input.existing.stream === "catalog" &&
    input.incoming.stream === "catalog"
  ) {
    if (
      providerStreamRecordIdentityHashV2(input.existing) !==
      providerStreamRecordIdentityHashV2(input.incoming)
    ) {
      return Object.freeze({
        kind: "quarantine",
        reasonCode: "CATALOG_IDENTITY_CONFLICT",
      });
    }
    const previousContentHash = providerStreamSourceFactsHashV2(input.existing);
    return previousContentHash === nextHash
      ? Object.freeze({ kind: "duplicate", contentHash: nextHash })
      : Object.freeze({
          kind: "catalog_revision",
          previousContentHash,
          contentHash: nextHash,
        });
  }
  if (
    providerStreamRecordIdentityHashV2(input.existing) !==
    providerStreamRecordIdentityHashV2(input.incoming)
  ) {
    return Object.freeze({
      kind: "quarantine",
      reasonCode: "SOURCE_IDENTITY_MISMATCH",
    });
  }
  const previousContentHash = providerStreamSourceFactsHashV2(input.existing);
  return previousContentHash === nextHash
    ? Object.freeze({ kind: "duplicate", contentHash: nextHash })
    : Object.freeze({
        kind: "quarantine",
        reasonCode: "IMMUTABLE_EVENT_CONFLICT",
      });
}
