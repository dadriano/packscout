import {
  normalizeCanonicalIdentity,
  normalizeCanonicalTimestamp,
} from "./canonical-projection-validation.ts";
import {
  calculatePackScoutEstimatedEv,
  PACKSCOUT_ESTIMATED_EV_UNAVAILABLE_REASON_ORDER,
  type CalculatePackScoutEstimatedEvInput,
  type PackScoutEstimatedEvResult,
  type PackScoutEstimatedEvUnitBasis,
} from "./estimated-ev-calculator.ts";
import {
  ESTIMATED_EV_PROJECTION_SCHEMA_VERSION,
  estimatedEvCalculationFingerprint,
  type CanonicalEstimatedEvProjectionContent,
  type EstimatedEvInputManifest,
  type EstimatedEvInputManifestBucket,
  type ExplainPackScoutEstimatedEvQuery,
  type PackScoutEstimatedEvExplanation,
  type PackScoutProviderReportedEvExplanation,
  type RecalculatePackScoutEstimatedEvCommand,
  type RecalculatePackScoutEstimatedEvResult,
} from "./estimated-ev-projection-contracts.ts";
import type {
  EstimatedEvCanonicalProjectionSnapshot,
  EstimatedEvProjectionRepository,
} from "./estimated-ev-projection-repository.ts";
import type { ProviderCanonicalProjectionCommand } from "./provider-import-types.ts";
import type { PipelineOperationalReporter } from "./operational-events.ts";

export type PackScoutEstimatedEvServiceErrorCode =
  | "CALCULATION_SOURCE_NOT_FOUND"
  | "INVALID_CURRENCY_POLICY"
  | "INVALID_PERSISTED_CALCULATION";

export class PackScoutEstimatedEvServiceError extends Error {
  constructor(readonly code: PackScoutEstimatedEvServiceErrorCode) {
    super("PackScout Estimated EV could not be processed.");
    this.name = "PackScoutEstimatedEvServiceError";
  }
}

const limitationValues = new Set([
  "incomplete_inventory",
  "midpoint_value_ranges",
  "provider_supplied_probabilities",
  "verified_usd_stablecoin_at_parity",
]);
const unavailableReasonValues = new Set<string>(
  PACKSCOUT_ESTIMATED_EV_UNAVAILABLE_REASON_ORDER,
);
const currencyTreatmentValues = new Set([
  "missing",
  "unsupported",
  "usd",
  "verified_usd_stablecoin",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function boundedToken(value: unknown, maximumLength = 512): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !hasControlCharacters(value)
    ? value
    : null;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function nullableSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unitBasis(value: unknown): PackScoutEstimatedEvUnitBasis | null {
  return value === "per_draw" || value === "per_pack" ? value : null;
}

function latestInstant(
  snapshots: readonly (EstimatedEvCanonicalProjectionSnapshot | null)[],
  field: "sourceCollectedAt" | "sourceUpdatedAt",
): Date | null {
  return snapshots.reduce<Date | null>((latest, snapshot) => {
    if (!snapshot) return latest;
    const candidate = snapshot[field];
    return !latest || candidate > latest ? candidate : latest;
  }, null);
}

function normalizeCurrencyPolicy(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.trim().toUpperCase());
  if (
    normalized.some(
      (value, index) =>
        value !== values[index] || !/^[A-Z0-9]{2,12}$/.test(value) || value === "USD",
    )
  ) {
    throw new PackScoutEstimatedEvServiceError("INVALID_CURRENCY_POLICY");
  }
  return Object.freeze([...new Set(normalized)].sort());
}

function manifestBuckets(
  evInput: EstimatedEvCanonicalProjectionSnapshot | null,
): readonly EstimatedEvInputManifestBucket[] {
  const content = record(evInput?.content);
  const buckets = content?.probabilityBuckets;
  if (!evInput || !Array.isArray(buckets)) return [];
  return Object.freeze(
    buckets
      .map((value) => {
        const bucket = record(value);
        return {
          bucketId: nullableString(bucket?.bucketId) ?? "",
          probability: nullableFiniteNumber(bucket?.probability),
          lowerValueMinor: nullableSafeInteger(bucket?.lowerValueMinor),
          upperValueMinor: nullableSafeInteger(bucket?.upperValueMinor),
          sourceRevisionId: evInput.revisionId,
        };
      })
      .sort((left, right) => left.bucketId.localeCompare(right.bucketId)),
  );
}

function inputManifest(input: {
  pack: EstimatedEvCanonicalProjectionSnapshot | null;
  evInput: EstimatedEvCanonicalProjectionSnapshot | null;
  verifiedUsdStablecoins: readonly string[];
}): EstimatedEvInputManifest {
  const packContent = record(input.pack?.content);
  const evContent = record(input.evInput?.content);
  const completeness = evContent?.evidenceCompleteness;
  return {
    packRevisionId: input.pack?.revisionId ?? null,
    evInputRevisionId: input.evInput?.revisionId ?? null,
    packPriceValueMinor: nullableSafeInteger(packContent?.priceValueMinor),
    packPriceCurrency: nullableString(packContent?.priceCurrency),
    distributionCurrency: nullableString(evContent?.currency),
    unitBasis: unitBasis(evContent?.unitBasis),
    drawCount: nullableSafeInteger(evContent?.drawCount),
    declaredCoverage: nullableFiniteNumber(record(evContent?.coverage)?.declaredCoverage),
    evidenceCompleteness:
      completeness === "complete" || completeness === "partial" || completeness === "unknown"
        ? completeness
        : "unknown",
    buckets: manifestBuckets(input.evInput),
    sourceAt: latestInstant([input.pack, input.evInput], "sourceUpdatedAt")?.toISOString() ?? null,
    verifiedUsdStablecoins: input.verifiedUsdStablecoins,
  };
}

function calculatorInput(
  manifest: EstimatedEvInputManifest,
  calculatedAt: string,
): CalculatePackScoutEstimatedEvInput {
  return {
    packPrice: manifest.packRevisionId
      ? {
          valueMinor: manifest.packPriceValueMinor,
          currency: manifest.packPriceCurrency,
          sourceRevisionId: manifest.packRevisionId,
        }
      : null,
    distributionCurrency: manifest.distributionCurrency,
    unitBasis: manifest.unitBasis,
    drawCount: manifest.drawCount,
    declaredCoverage: manifest.declaredCoverage,
    evidenceCompleteness: manifest.evidenceCompleteness,
    buckets: manifest.buckets.map((bucket) => ({
      probability: bucket.probability,
      lowerValueMinor: bucket.lowerValueMinor,
      upperValueMinor: bucket.upperValueMinor,
      sourceRevisionId: bucket.sourceRevisionId,
    })),
    sourceAt: manifest.sourceAt,
    calculatedAt,
    currencyPolicy: {
      verifiedUsdStablecoins: manifest.verifiedUsdStablecoins,
    },
  };
}

function projectionContent(
  result: PackScoutEstimatedEvResult,
  fingerprint: string,
  manifest: EstimatedEvInputManifest,
): CanonicalEstimatedEvProjectionContent {
  return {
    schemaVersion: ESTIMATED_EV_PROJECTION_SCHEMA_VERSION,
    label: "PackScout Estimated EV",
    calculationFingerprint: fingerprint,
    status: result.status,
    grossValueMinor: result.grossValueMinor,
    evPercent: result.evPercent,
    currency: result.currency,
    method: result.method,
    methodVersion: result.methodVersion,
    coveragePercent: result.coveragePercent,
    inputCount: result.inputCount,
    sourceAt: result.sourceAt,
    calculatedAt: result.calculatedAt,
    reasonCodes: result.reasonCodes,
    evidence: result.evidence,
    inputManifest: manifest,
  };
}

function providerReportedEv(
  pack: EstimatedEvCanonicalProjectionSnapshot | null,
): PackScoutProviderReportedEvExplanation | null {
  const content = record(pack?.content);
  const valueMinor = nullableSafeInteger(content?.providerReportedEvValueMinor);
  const currency = boundedToken(content?.providerReportedEvCurrency, 12);
  if (!pack || valueMinor === null || valueMinor < 0 || currency === null) return null;
  return {
    status: "reported",
    valueMinor,
    currency,
    sourceAt: pack.sourceUpdatedAt.toISOString(),
    sourceRevisionId: pack.revisionId,
  };
}

function persistedContent(
  calculation: EstimatedEvCanonicalProjectionSnapshot,
): CanonicalEstimatedEvProjectionContent | null {
  const content = record(calculation.content);
  const evidence = record(content?.evidence);
  const inputManifest = record(content?.inputManifest);
  const reasonCodes = content?.reasonCodes;
  const limitations = evidence?.limitations;
  const sourceRevisionIds = evidence?.sourceRevisionIds;
  const basis = evidence?.unitBasis;
  const priceTreatment = evidence?.priceCurrencyTreatment;
  const distributionTreatment = evidence?.distributionCurrencyTreatment;
  const estimatedValuesAreValid =
    content?.status !== "estimated" ||
    (nullableSafeInteger(content.grossValueMinor) !== null &&
      nullableFiniteNumber(content.evPercent) !== null &&
      content.currency === "USD" &&
      Array.isArray(reasonCodes) && reasonCodes.length === 0);
  const unavailableValuesAreValid =
    content?.status !== "unavailable" ||
    (content.grossValueMinor === null &&
      content.evPercent === null &&
      content.currency === null);
  if (
    content?.schemaVersion !== ESTIMATED_EV_PROJECTION_SCHEMA_VERSION ||
    content.label !== "PackScout Estimated EV" ||
    (content.status !== "estimated" && content.status !== "unavailable") ||
    boundedToken(content.calculationFingerprint, 128) === null ||
    boundedToken(content.method, 128) === null ||
    boundedToken(content.methodVersion, 128) === null ||
    nullableFiniteNumber(content.coveragePercent) === null ||
    nullableSafeInteger(content.inputCount) === null ||
    (content.sourceAt !== null && !isInstant(content.sourceAt)) ||
    !isInstant(content.calculatedAt) ||
    !Array.isArray(reasonCodes) ||
    !reasonCodes.every((reason) => unavailableReasonValues.has(String(reason))) ||
    !evidence ||
    (basis !== null && basis !== "per_draw" && basis !== "per_pack") ||
    !Array.isArray(limitations) ||
    !limitations.every((limitation) => limitationValues.has(String(limitation))) ||
    !Array.isArray(sourceRevisionIds) ||
    !sourceRevisionIds.every((revisionId) => boundedToken(revisionId) !== null) ||
    !currencyTreatmentValues.has(String(priceTreatment)) ||
    !currencyTreatmentValues.has(String(distributionTreatment)) ||
    evidence.currencyPolicy !== "usd_and_explicit_verified_usd_stablecoins_v1" ||
    !inputManifest ||
    !estimatedValuesAreValid ||
    !unavailableValuesAreValid
  ) {
    return null;
  }
  return content as unknown as CanonicalEstimatedEvProjectionContent;
}

function explanation(
  content: CanonicalEstimatedEvProjectionContent,
  pack: EstimatedEvCanonicalProjectionSnapshot | null,
): PackScoutEstimatedEvExplanation {
  const basis = content.evidence.unitBasis;
  return {
    label: content.label,
    status: content.status,
    grossValueMinor: content.grossValueMinor,
    evPercent: content.evPercent,
    currency: content.currency,
    unitBasis: basis,
    unitLabel: basis === "per_draw" ? "per draw" : basis === "per_pack" ? "per pack" : null,
    method: content.method,
    methodVersion: content.methodVersion,
    coveragePercent: content.coveragePercent,
    inputCount: content.inputCount,
    sourceAt: content.sourceAt,
    calculatedAt: content.calculatedAt,
    reasonCodes: Object.freeze([...content.reasonCodes]),
    limitations: Object.freeze([...content.evidence.limitations]),
    sourceRevisionIds: Object.freeze([...content.evidence.sourceRevisionIds]),
    currencyTreatment: {
      price: content.evidence.priceCurrencyTreatment,
      distribution: content.evidence.distributionCurrencyTreatment,
      policy: content.evidence.currencyPolicy,
    },
    providerReportedEv: providerReportedEv(pack),
  };
}

function commandProjection(input: {
  platformKey: string;
  packExternalId: string;
  content: CanonicalEstimatedEvProjectionContent;
  sourceUpdatedAt: Date;
  sourceCollectedAt: Date;
}): ProviderCanonicalProjectionCommand {
  return {
    platformKey: input.platformKey,
    recordKind: "estimated_ev",
    externalId: input.packExternalId,
    content: { ...input.content },
    provenance: {
      calculationFingerprint: input.content.calculationFingerprint,
      method: input.content.method,
      methodVersion: input.content.methodVersion,
      packRevisionId: input.content.inputManifest.packRevisionId,
      evInputRevisionId: input.content.inputManifest.evInputRevisionId,
    },
    sourceUpdatedAt: input.sourceUpdatedAt,
    sourceCollectedAt: input.sourceCollectedAt,
    relationships: [
      {
        relationshipKind: "estimates_pack",
        targetPlatformKey: input.platformKey,
        targetRecordKind: "pack",
        targetExternalId: input.packExternalId,
      },
    ],
  };
}

export class PackScoutEstimatedEvService {
  constructor(
    private readonly repository: EstimatedEvProjectionRepository,
    private readonly operational?: Pick<PipelineOperationalReporter, "calculation">,
  ) {}

  async recalculate(
    command: RecalculatePackScoutEstimatedEvCommand,
  ): Promise<RecalculatePackScoutEstimatedEvResult> {
    const calculatedAt = normalizeCanonicalTimestamp(
      command.calculatedAt,
      "calculatedAt",
    );
    const organizationId = normalizeCanonicalIdentity(command.organizationId, "organizationId");
    const providerId = normalizeCanonicalIdentity(command.providerId, "providerId");
    const platformKey = normalizeCanonicalIdentity(command.platformKey, "platformKey");
    const packExternalId = normalizeCanonicalIdentity(command.packExternalId, "packExternalId");
    const evInputExternalId = normalizeCanonicalIdentity(
      command.evInputExternalId,
      "evInputExternalId",
    );
    const inputs = await this.repository.loadCalculationInputs({
      organizationId,
      platformKey,
      packExternalId,
      evInputExternalId,
    });
    const source = inputs.evInput ?? inputs.pack;
    if (!source) {
      throw new PackScoutEstimatedEvServiceError("CALCULATION_SOURCE_NOT_FOUND");
    }
    const manifest = inputManifest({
      pack: inputs.pack,
      evInput: inputs.evInput,
      verifiedUsdStablecoins: normalizeCurrencyPolicy(
        command.currencyPolicy.verifiedUsdStablecoins,
      ),
    });
    const fingerprint = estimatedEvCalculationFingerprint(manifest);
    const current = inputs.calculation ? persistedContent(inputs.calculation) : null;
    if (current?.calculationFingerprint === fingerprint && inputs.calculation) {
      const unchanged: RecalculatePackScoutEstimatedEvResult = {
        persistenceStatus: "unchanged",
        calculationRevisionId: inputs.calculation.revisionId,
        calculationRevisionNumber: inputs.calculation.revisionNumber,
        explanation: explanation(current, inputs.pack),
        derivationAcknowledged: false,
      };
      this.reportAvailability(organizationId, providerId, unchanged.explanation);
      return unchanged;
    }
    const result = calculatePackScoutEstimatedEv(
      calculatorInput(manifest, calculatedAt.toISOString()),
    );
    const content = projectionContent(result, fingerprint, manifest);
    const sourceUpdatedAt = latestInstant(
      [inputs.pack, inputs.evInput],
      "sourceUpdatedAt",
    ) ?? calculatedAt;
    const sourceCollectedAt = latestInstant(
      [inputs.pack, inputs.evInput],
      "sourceCollectedAt",
    ) ?? calculatedAt;
    const persisted = await this.repository.persistCalculation({
      organizationId,
      providerId,
      configurationRevisionId: normalizeCanonicalIdentity(
        command.configurationRevisionId,
        "configurationRevisionId",
      ),
      sourceRecordId: source.sourceRecordId,
      projection: commandProjection({
        platformKey,
        packExternalId,
        content,
        sourceUpdatedAt,
        sourceCollectedAt,
      }),
      acceptedAt: calculatedAt,
      ...(command.recomputation
        ? {
            recomputation: {
              ...command.recomputation,
              resultStatus: result.status,
              ...(result.status === "unavailable"
                ? { outcomeReasonCode: result.reasonCodes[0] }
                : {}),
            },
          }
        : {}),
    });
    const persistedCalculation = persistedContent(persisted.calculation);
    if (!persistedCalculation) {
      throw new PackScoutEstimatedEvServiceError("INVALID_PERSISTED_CALCULATION");
    }
    const recalculated: RecalculatePackScoutEstimatedEvResult = {
      persistenceStatus: persisted.created ? "revised" : "unchanged",
      calculationRevisionId: persisted.calculation.revisionId,
      calculationRevisionNumber: persisted.calculation.revisionNumber,
      explanation: explanation(persistedCalculation, inputs.pack),
      derivationAcknowledged: persisted.derivationAcknowledged ?? false,
    };
    this.reportAvailability(organizationId, providerId, recalculated.explanation);
    return recalculated;
  }

  async explain(
    query: ExplainPackScoutEstimatedEvQuery,
  ): Promise<PackScoutEstimatedEvExplanation | null> {
    const input = await this.repository.getCurrentExplanationInput({
      organizationId: normalizeCanonicalIdentity(query.organizationId, "organizationId"),
      platformKey: normalizeCanonicalIdentity(query.platformKey, "platformKey"),
      packExternalId: normalizeCanonicalIdentity(query.packExternalId, "packExternalId"),
    });
    if (!input.calculation) return null;
    const content = persistedContent(input.calculation);
    return content ? explanation(content, input.pack) : null;
  }

  private reportAvailability(
    organizationId: string,
    providerId: string,
    result: PackScoutEstimatedEvExplanation,
  ): void {
    if (!this.operational) return;
    const availability =
      result.status === "unavailable"
        ? "UNAVAILABLE"
        : result.limitations.length > 0
          ? "LIMITED"
          : "AVAILABLE";
    try {
      this.operational.calculation({
        organizationId,
        providerId,
        availability,
      });
    } catch {
      // A committed calculation must not depend on operational telemetry.
    }
  }
}
