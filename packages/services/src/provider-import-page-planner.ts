import {
  providerRecordKindV2,
  type ProviderRecordKindV2,
  type ProviderStreamInvalidRecordOutcomeV2,
  type ProviderStreamRecordV2,
  type ProviderStreamValidRecordOutcomeV2,
  type ProviderStreamValidatedPageV2,
} from "@packscout/contracts";
import { ProviderMappingAdapterRegistry } from "./provider-adapter-registry.ts";
import {
  sourceIdentityForRecord,
  type ProviderRecordMappingOutcome,
  type ProviderSourceIdentity,
} from "./provider-adapter.ts";
import type {
  ProviderImportMappedPage,
  ProviderArchiveImportPagePlanner,
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

function parseableExternalId(rawRecord: unknown): string | null {
  if (
    typeof rawRecord !== "object" ||
    rawRecord === null ||
    !("record_id" in rawRecord)
  ) {
    return null;
  }
  const value = rawRecord.record_id;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function recordKindForInvalid(rawRecord: unknown): ProviderRecordKindV2 {
  if (typeof rawRecord !== "object" || rawRecord === null || !("stream" in rawRecord)) {
    return "catalog";
  }
  return rawRecord.stream === "pulls"
    ? "pull"
    : rawRecord.stream === "trades"
      ? "trade"
      : "catalog";
}

function invalidEnvelopeQuarantine(
  outcome: ProviderStreamInvalidRecordOutcomeV2,
): ProviderImportQuarantineInput {
  const issue = outcome.issues[0];
  return {
    recordKind: recordKindForInvalid(outcome.rawRecord),
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
  record: ProviderStreamRecordV2,
  recordIndex: number,
  source: ProviderSourceIdentity,
  reasonCode: string,
  fieldPath: string | undefined,
  summary: string,
): ProviderImportSourceRecordInput {
  return {
    recordKind: providerRecordKindV2(record),
    recordIndex,
    externalId: source.externalId,
    sourceTime: new Date(source.sourceTimestamp),
    collectedAt: new Date(source.collectedAt),
    payload: record,
    projections: [],
    quarantine: {
      reasonCode,
      ...(fieldPath ? { fieldPath } : {}),
      sanitizedSummary: summary,
    },
  };
}

export class DefaultProviderImportPagePlanner implements
  ProviderImportPagePlanner,
  ProviderArchiveImportPagePlanner {
  constructor(
    private readonly mappings: ProviderMappingAdapterRegistry,
    private readonly projections: ProviderProjectionPort,
  ) {}

  async plan(input: {
    configuration: Parameters<ProviderImportPagePlanner["plan"]>[0]["configuration"];
    page: ProviderStreamValidatedPageV2;
  }): Promise<ProviderImportMappedPage> {
    const mapper = this.mappings.resolveForPlatform(input.configuration.platform);
    return this.planWithMapper(input, mapper);
  }

  async planArchive(input: {
    configuration: Parameters<ProviderArchiveImportPagePlanner["planArchive"]>[0]["configuration"];
    page: ProviderStreamValidatedPageV2;
  }): Promise<ProviderImportMappedPage> {
    let mapper;
    try {
      mapper = this.mappings.resolve(
        input.configuration.adapterKey,
        input.configuration.platform,
      );
    } catch {
      throw new ProviderImportPlanningError();
    }
    return this.planWithMapper(input, mapper);
  }

  private async planWithMapper(
    input: Parameters<ProviderImportPagePlanner["plan"]>[0],
    mapper: ReturnType<ProviderMappingAdapterRegistry["resolve"]>,
  ): Promise<ProviderImportMappedPage> {
    const mappingConfiguration = {
      ...input.configuration,
      adapterKey: mapper.key,
    };
    const validRecords = input.page.recordOutcomes.filter(
      (outcome): outcome is ProviderStreamValidRecordOutcomeV2 =>
        outcome.status === "valid",
    );
    const records: ProviderImportSourceRecordInput[] = [];

    for (const valid of validRecords) {
      const source = sourceIdentityForRecord({
        record: valid.record,
        recordIndex: valid.recordIndex,
      });
      let outcome: ProviderRecordMappingOutcome;
      try {
        outcome = await mapper.mapRecord({
          configuration: mappingConfiguration,
          record: valid.record,
          recordIndex: valid.recordIndex,
        });
      } catch {
        records.push(
          quarantinedSourceRecord(
            valid.record,
            valid.recordIndex,
            source,
            "MAPPING_FAILED",
            undefined,
            "A provider record could not be mapped.",
          ),
        );
        continue;
      }
      if (!sameSource(outcome.source, source)) {
        throw new ProviderImportPlanningError();
      }
      if (outcome.status === "invalid") {
        records.push(
          quarantinedSourceRecord(
            valid.record,
            valid.recordIndex,
            source,
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
            valid.record,
            valid.recordIndex,
            source,
            "MAPPING_SOURCE_MISMATCH",
            undefined,
            "A provider mapping referenced inconsistent source evidence.",
          ),
        );
        continue;
      }
      try {
        const projected = await this.projections.project({
          configuration: mappingConfiguration,
          source,
          candidates: outcome.candidates,
        });
        if (projected.status === "invalid") {
          records.push(
            quarantinedSourceRecord(
              valid.record,
              valid.recordIndex,
              source,
              stableReasonCode(projected.reasonCode, "PROJECTION_REJECTED"),
              stableFieldPath(projected.fieldPath),
              "A provider record failed canonical projection.",
            ),
          );
          continue;
        }
        records.push({
          recordKind: providerRecordKindV2(valid.record),
          recordIndex: valid.recordIndex,
          externalId: source.externalId,
          sourceTime: new Date(source.sourceTimestamp),
          collectedAt: new Date(source.collectedAt),
          payload: valid.record,
          projections: projected.projections,
        });
      } catch {
        records.push(
          quarantinedSourceRecord(
            valid.record,
            valid.recordIndex,
            source,
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
