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

function sourceIdentity(record: ProviderStreamRecordV2): string {
  return [record.stream, record.platform, record.record_id].join("\u0000");
}

function catalogIdentity(record: Extract<ProviderStreamRecordV2, { stream: "catalog" }>) {
  return [
    sourceIdentity(record),
    record.entity,
    record.first_seen_at,
  ].join("\u0000");
}

/**
 * Observation time is deliberately excluded. Re-observing unchanged source
 * facts records an observation but must not manufacture a new catalog revision
 * or immutable-event conflict solely because collection happened later.
 */
function contentHash(record: ProviderStreamRecordV2): string {
  const sourceFacts = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "collected_at"),
  );
  return hashJson(sourceFacts);
}

export function decideProviderStreamWriteV2(input: {
  readonly existing: ProviderStreamRecordV2 | null;
  readonly incoming: ProviderStreamRecordV2;
}): ProviderStreamWriteDecisionV2 {
  const nextHash = contentHash(input.incoming);
  if (input.existing === null) {
    return Object.freeze({ kind: "accept_initial", contentHash: nextHash });
  }
  if (
    input.existing.stream === "catalog" &&
    input.incoming.stream === "catalog"
  ) {
    if (catalogIdentity(input.existing) !== catalogIdentity(input.incoming)) {
      return Object.freeze({
        kind: "quarantine",
        reasonCode: "CATALOG_IDENTITY_CONFLICT",
      });
    }
    const previousContentHash = contentHash(input.existing);
    return previousContentHash === nextHash
      ? Object.freeze({ kind: "duplicate", contentHash: nextHash })
      : Object.freeze({
          kind: "catalog_revision",
          previousContentHash,
          contentHash: nextHash,
        });
  }
  if (sourceIdentity(input.existing) !== sourceIdentity(input.incoming)) {
    return Object.freeze({
      kind: "quarantine",
      reasonCode: "SOURCE_IDENTITY_MISMATCH",
    });
  }
  const previousContentHash = contentHash(input.existing);
  return previousContentHash === nextHash
    ? Object.freeze({ kind: "duplicate", contentHash: nextHash })
    : Object.freeze({
        kind: "quarantine",
        reasonCode: "IMMUTABLE_EVENT_CONFLICT",
      });
}

export function assertStreamLocalPageCommitV2(input: {
  readonly runStream: ProviderStreamRecordV2["stream"];
  readonly pageStream: ProviderStreamRecordV2["stream"];
  readonly records: readonly ProviderStreamRecordV2[];
}): void {
  if (
    input.runStream !== input.pageStream ||
    input.records.some((record) => record.stream !== input.runStream)
  ) {
    throw new RangeError("Provider page cannot cross stream checkpoints.");
  }
}
