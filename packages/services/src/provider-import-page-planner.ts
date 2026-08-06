import type {
  ProviderFeedInvalidRecordOutcomeV1,
  ProviderFeedValidatedPageV1,
  ProviderFeedValidRecordOutcomeV1,
} from "@packscout/contracts";
import { ProviderMappingAdapterRegistry } from "./provider-adapter-registry.ts";
import {
  type ProviderRecordMappingOutcome,
  type ProviderSourceIdentity,
} from "./provider-adapter.ts";
import type {
  ProviderImportMappedPage,
  ProviderImportPagePlanner,
  ProviderImportQuarantineInput,
  ProviderImportSourceRecordInput,
  ProviderProjectionPort,
} from "./provider-import-types.ts";

const safeReasonCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const safeFieldPathPattern = /^[A-Za-z0-9_$.[\]-]{1,256}$/;

export class ProviderImportPlanningError extends Error {
  readonly code = "IMPORT_MAPPING_FAILED";

  constructor() {
    super("Provider mapping could not safely process the page.");
    this.name = "ProviderImportPlanningError";
  }
}

function stableReasonCode(value: string, fallback: string): string {
  return safeReasonCodePattern.test(value) ? value : fallback;
}

function stableFieldPath(value: string | undefined): string | undefined {
  return value && safeFieldPathPattern.test(value) ? value : undefined;
}

function sourceKey(source: ProviderSourceIdentity): string {
  return `${source.recordKind}:${source.recordIndex}`;
}

function sameSource(
  left: ProviderSourceIdentity,
  right: ProviderSourceIdentity,
): boolean {
  return (
    left.platform === right.platform &&
    left.recordKind === right.recordKind &&
    left.recordIndex === right.recordIndex &&
    left.externalId === right.externalId &&
    left.collectedAt === right.collectedAt &&
    left.sourceTimestamp === right.sourceTimestamp
  );
}

function sourceForValidRecord(
  record: ProviderFeedValidRecordOutcomeV1,
): ProviderSourceIdentity {
  return {
    platform: record.envelope.platform,
    recordKind: record.recordKind,
    recordIndex: record.recordIndex,
    externalId: record.envelope.external_id,
    collectedAt: record.envelope.collected_at,
    sourceTimestamp:
      "updated_at" in record.envelope
        ? record.envelope.updated_at
        : record.envelope.occurred_at,
  };
}

function parseableExternalId(rawRecord: unknown): string | null {
  if (
    typeof rawRecord !== "object" ||
    rawRecord === null ||
    !("external_id" in rawRecord)
  ) {
    return null;
  }
  const value = rawRecord.external_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function invalidEnvelopeQuarantine(
  outcome: ProviderFeedInvalidRecordOutcomeV1,
): ProviderImportQuarantineInput {
  const issue = outcome.issues[0];
  return {
    recordKind: outcome.recordKind,
    recordIndex: outcome.recordIndex,
    externalId: parseableExternalId(outcome.rawRecord),
    reasonCode: issue
      ? `INVALID_ENVELOPE_${issue.code.toUpperCase()}`
      : "INVALID_ENVELOPE",
    ...(issue ? { fieldPath: stableFieldPath(issue.path) } : {}),
    sanitizedSummary: "A provider record failed envelope validation.",
    payload: outcome.rawRecord,
  };
}

function quarantinedSourceRecord(
  record: ProviderFeedValidRecordOutcomeV1,
  source: ProviderSourceIdentity,
  payload: Record<string, unknown>,
  reasonCode: string,
  fieldPath: string | undefined,
  summary: string,
): ProviderImportSourceRecordInput {
  return {
    recordKind: record.recordKind,
    recordIndex: record.recordIndex,
    externalId: source.externalId,
    sourceTime: new Date(source.sourceTimestamp),
    collectedAt: new Date(source.collectedAt),
    payload,
    projections: [],
    quarantine: {
      reasonCode,
      ...(fieldPath ? { fieldPath } : {}),
      sanitizedSummary: summary,
    },
  };
}

function rawValidEnvelope(
  page: ProviderFeedValidatedPageV1,
  record: ProviderFeedValidRecordOutcomeV1,
): Record<string, unknown> {
  const raw =
    record.recordKind === "catalog"
      ? page.rawPage.catalog[record.recordIndex]
      : record.recordKind === "pull"
        ? page.rawPage.pulls[record.recordIndex]
        : page.rawPage.sales[record.recordIndex];
  return typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : record.envelope;
}

function recordIndexes(page: ProviderFeedValidatedPageV1) {
  const valid = page.recordOutcomes.filter(
    (outcome): outcome is ProviderFeedValidRecordOutcomeV1 =>
      outcome.status === "valid",
  );
  return {
    catalog: valid
      .filter((outcome) => outcome.recordKind === "catalog")
      .map((outcome) => outcome.recordIndex),
    pulls: valid
      .filter((outcome) => outcome.recordKind === "pull")
      .map((outcome) => outcome.recordIndex),
    sales: valid
      .filter((outcome) => outcome.recordKind === "sale")
      .map((outcome) => outcome.recordIndex),
  };
}

export class DefaultProviderImportPagePlanner
  implements ProviderImportPagePlanner
{
  constructor(
    private readonly mappings: ProviderMappingAdapterRegistry,
    private readonly projections: ProviderProjectionPort,
  ) {}

  async plan(input: {
    configuration: Parameters<ProviderImportPagePlanner["plan"]>[0]["configuration"];
    page: ProviderFeedValidatedPageV1;
  }): Promise<ProviderImportMappedPage> {
    const mapper = this.mappings.resolveForPlatform(input.configuration.platform);
    let output: Awaited<ReturnType<typeof mapper.mapPage>>;
    try {
      output = await mapper.mapPage({
        configuration: input.configuration,
        page: input.page.validPage,
        recordIndexes: recordIndexes(input.page),
      });
    } catch {
      throw new ProviderImportPlanningError();
    }

    const validRecords = input.page.recordOutcomes.filter(
      (outcome): outcome is ProviderFeedValidRecordOutcomeV1 =>
        outcome.status === "valid",
    );
    const expected = new Map(
      validRecords.map((record) => {
        const source = sourceForValidRecord(record);
        return [
          sourceKey(source),
          { record, source, payload: rawValidEnvelope(input.page, record) },
        ] as const;
      }),
    );
    const mappedOutcomes = new Map<string, ProviderRecordMappingOutcome>();
    for (const outcome of output.outcomes) {
      const key = sourceKey(outcome.source);
      const expectedSource = expected.get(key)?.source;
      if (
        !expectedSource ||
        !sameSource(outcome.source, expectedSource) ||
        mappedOutcomes.has(key)
      ) {
        throw new ProviderImportPlanningError();
      }
      mappedOutcomes.set(key, outcome);
    }

    const records: ProviderImportSourceRecordInput[] = [];
    for (const { record, source, payload } of expected.values()) {
      const outcome = mappedOutcomes.get(sourceKey(source));
      if (!outcome) {
        records.push(
          quarantinedSourceRecord(
            record,
            source,
            payload,
            "MAPPING_OUTCOME_MISSING",
            undefined,
            "A provider record produced no mapping outcome.",
          ),
        );
        continue;
      }
      if (outcome.status === "invalid") {
        records.push(
          quarantinedSourceRecord(
            record,
            source,
            payload,
            stableReasonCode(outcome.failure.reasonCode, "MAPPING_REJECTED"),
            stableFieldPath(outcome.failure.fieldPath),
            "A provider record failed mapping.",
          ),
        );
        continue;
      }
      if (outcome.candidates.some((candidate) => !sameSource(candidate.source, source))) {
        records.push(
          quarantinedSourceRecord(
            record,
            source,
            payload,
            "MAPPING_SOURCE_MISMATCH",
            undefined,
            "A provider mapping referenced inconsistent source evidence.",
          ),
        );
        continue;
      }
      try {
        const projected = await this.projections.project({
          configuration: input.configuration,
          source,
          candidates: outcome.candidates,
        });
        if (projected.status === "invalid") {
          records.push(
            quarantinedSourceRecord(
              record,
              source,
              payload,
              stableReasonCode(projected.reasonCode, "PROJECTION_REJECTED"),
              stableFieldPath(projected.fieldPath),
              "A provider record failed canonical projection.",
            ),
          );
          continue;
        }
        records.push({
          recordKind: record.recordKind,
          recordIndex: record.recordIndex,
          externalId: source.externalId,
          sourceTime: new Date(source.sourceTimestamp),
          collectedAt: new Date(source.collectedAt),
          payload,
          projections: projected.projections,
        });
      } catch {
        records.push(
          quarantinedSourceRecord(
            record,
            source,
            payload,
            "PROJECTION_FAILED",
            undefined,
            "A provider record could not be projected.",
          ),
        );
      }
    }
    return {
      records,
      quarantines: input.page.invalidRecords.map(invalidEnvelopeQuarantine),
    };
  }
}
