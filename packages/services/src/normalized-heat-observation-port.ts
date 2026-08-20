import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL,
  REPACK_HEAT_MAXIMUM_OBSERVATIONS,
  parseRepackHeatTimestampMillis,
  publicRepackIdSchema,
} from "@packscout/contracts";
import {
  compareNormalizedHeatObservations,
  toRepackHeatObservation,
  validateNormalizedHeatObservation,
  type NormalizedHeatObservation,
} from "./normalized-heat-observation-contracts.ts";
import { resolvePackScoutPublicOrganizationId } from "./public-change-settlement-service.ts";
import type {
  RepackHeatCalculationWindow,
  RepackHeatObservation,
} from "./repack-heat-calculator.ts";

export const NORMALIZED_HEAT_CURRENT_WINDOW_MILLISECONDS =
  15 * 60 * 1_000;
export const NORMALIZED_HEAT_BASELINE_WINDOW_MILLISECONDS =
  24 * 60 * 60 * 1_000;
export const NORMALIZED_HEAT_DEFAULT_QUERY_LIMIT =
  REPACK_HEAT_MAXIMUM_OBSERVATIONS;

export type NormalizedHeatReadErrorCode =
  | "NORMALIZED_HEAT_QUERY_INVALID"
  | "NORMALIZED_HEAT_RESULT_INVALID";

export class NormalizedHeatReadError extends Error {
  constructor(readonly code: NormalizedHeatReadErrorCode) {
    super("Normalized Heat observations could not be read safely.");
    this.name = "NormalizedHeatReadError";
  }
}

/**
 * A repository must apply every bound in this query. In particular, the time
 * interval is half-open and the causal sequence is an inclusive settled cap.
 */
export interface NormalizedHeatObservationQuery {
  readonly organizationId: string;
  readonly publicRepackIds: readonly string[];
  readonly occurredAtGte: string;
  readonly occurredAtLt: string;
  readonly causalSequenceLte: bigint;
  readonly limit: number;
}

export interface NormalizedHeatObservationPage {
  readonly observations: readonly unknown[];
  /** False when the canonical sources could not prove complete coverage. */
  readonly sourceCoverageComplete: boolean;
  /** True when the bounded repository limit omitted matching observations. */
  readonly truncated: boolean;
}

export interface NormalizedHeatObservationReadPort {
  listSettledNormalizedHeatObservations(
    query: NormalizedHeatObservationQuery,
  ): Promise<NormalizedHeatObservationPage>;
}

export interface NormalizedHeatFrameWindows {
  readonly baselineWindow: RepackHeatCalculationWindow;
  readonly currentWindow: RepackHeatCalculationWindow;
  readonly occurredAtGte: string;
  readonly occurredAtLt: string;
}

export interface NormalizedHeatFrameRead {
  readonly observations: readonly RepackHeatObservation[];
  readonly sourceCoverageComplete: boolean;
  readonly truncated: boolean;
}

function refuse(code: NormalizedHeatReadErrorCode): never {
  throw new NormalizedHeatReadError(code);
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    parseRepackHeatTimestampMillis(value) === null
  ) {
    refuse("NORMALIZED_HEAT_QUERY_INVALID");
  }
  return value;
}

function publicRepackIds(value: readonly string[]): readonly string[] {
  if (
    value.length === 0 ||
    value.length > MAX_PUBLIC_REPACKS_PER_RELEASE
  ) {
    refuse("NORMALIZED_HEAT_QUERY_INVALID");
  }
  const parsed = value.map((id) => {
    const result = publicRepackIdSchema.safeParse(id);
    if (!result.success) refuse("NORMALIZED_HEAT_QUERY_INVALID");
    return result.data;
  });
  parsed.sort();
  if (parsed.some((id, index) => index > 0 && id === parsed[index - 1])) {
    refuse("NORMALIZED_HEAT_QUERY_INVALID");
  }
  return Object.freeze(parsed);
}

function settledSequence(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    refuse("NORMALIZED_HEAT_QUERY_INVALID");
  }
  return value;
}

function queryLimit(value: number | undefined): number {
  const limit = value ?? NORMALIZED_HEAT_DEFAULT_QUERY_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > REPACK_HEAT_MAXIMUM_OBSERVATIONS
  ) {
    refuse("NORMALIZED_HEAT_QUERY_INVALID");
  }
  return limit;
}

export function buildNormalizedHeatFrameWindows(
  frameEndedAt: string,
): NormalizedHeatFrameWindows {
  const endedAt = canonicalTimestamp(frameEndedAt);
  const endedAtMillis = parseRepackHeatTimestampMillis(endedAt)!;
  const currentStartedAt = new Date(
    endedAtMillis - NORMALIZED_HEAT_CURRENT_WINDOW_MILLISECONDS,
  ).toISOString();
  const baselineStartedAt = new Date(
    endedAtMillis -
      NORMALIZED_HEAT_CURRENT_WINDOW_MILLISECONDS -
      NORMALIZED_HEAT_BASELINE_WINDOW_MILLISECONDS,
  ).toISOString();

  return Object.freeze({
    baselineWindow: Object.freeze({
      startAt: baselineStartedAt,
      endAt: currentStartedAt,
    }),
    currentWindow: Object.freeze({
      startAt: currentStartedAt,
      endAt: endedAt,
    }),
    occurredAtGte: baselineStartedAt,
    occurredAtLt: endedAt,
  });
}

function validatePageFlags(page: NormalizedHeatObservationPage): void {
  if (
    typeof page.sourceCoverageComplete !== "boolean" ||
    typeof page.truncated !== "boolean" ||
    !Array.isArray(page.observations)
  ) {
    refuse("NORMALIZED_HEAT_RESULT_INVALID");
  }
}

function validatedPageObservations(input: {
  page: NormalizedHeatObservationPage;
  knownRepackIds: ReadonlySet<string>;
  windows: NormalizedHeatFrameWindows;
  maximumSettledCausalSequence: bigint;
  limit: number;
}): readonly NormalizedHeatObservation[] {
  validatePageFlags(input.page);
  if (input.page.observations.length > input.limit) {
    refuse("NORMALIZED_HEAT_RESULT_INVALID");
  }

  const observations = input.page.observations.map((candidate) => {
    let observation: NormalizedHeatObservation;
    try {
      observation = validateNormalizedHeatObservation(candidate);
    } catch {
      return refuse("NORMALIZED_HEAT_RESULT_INVALID");
    }
    if (
      !input.knownRepackIds.has(observation.publicRepackId) ||
      observation.causalSequence > input.maximumSettledCausalSequence ||
      observation.occurredAt < input.windows.occurredAtGte ||
      observation.occurredAt >= input.windows.occurredAtLt
    ) {
      refuse("NORMALIZED_HEAT_RESULT_INVALID");
    }
    return observation;
  });

  observations.sort(compareNormalizedHeatObservations);
  const observationKeys = new Set<string>();
  const catalogRevisions = new Set<string>();
  const encoder = new TextEncoder();
  let outcomeKeyCount = 0;
  let outcomeByteCount = 0;
  for (const observation of observations) {
    if (observationKeys.has(observation.observationKey)) {
      refuse("NORMALIZED_HEAT_RESULT_INVALID");
    }
    observationKeys.add(observation.observationKey);
    if (observation.kind !== "catalog_snapshot") continue;

    const catalogRevision = `${observation.publicRepackId}:${observation.occurredAt}:${observation.catalogSequence}`;
    if (catalogRevisions.has(catalogRevision)) {
      refuse("NORMALIZED_HEAT_RESULT_INVALID");
    }
    catalogRevisions.add(catalogRevision);
    outcomeKeyCount += observation.outcomeKeys.length;
    for (const outcomeKey of observation.outcomeKeys) {
      outcomeByteCount += encoder.encode(outcomeKey).byteLength;
    }
    if (
      outcomeKeyCount > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL ||
      outcomeByteCount > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL
    ) {
      refuse("NORMALIZED_HEAT_RESULT_INVALID");
    }
  }
  return Object.freeze(observations);
}

/**
 * Keeps organization selection out of request data and defensively rechecks
 * settlement, time, identity, uniqueness, and calculator-wide budgets.
 */
export class NormalizedHeatObservationService {
  readonly #organizationId: string;

  constructor(
    private readonly repository: NormalizedHeatObservationReadPort,
    configuration: { organizationId: string },
  ) {
    this.#organizationId = resolvePackScoutPublicOrganizationId(
      configuration.organizationId,
    );
  }

  async readFrame(input: {
    publicRepackIds: readonly string[];
    frameEndedAt: string;
    maximumSettledCausalSequence: bigint;
    limit?: number;
  }): Promise<NormalizedHeatFrameRead> {
    const ids = publicRepackIds(input.publicRepackIds);
    const windows = buildNormalizedHeatFrameWindows(input.frameEndedAt);
    const maximumSettledCausalSequence = settledSequence(
      input.maximumSettledCausalSequence,
    );
    const limit = queryLimit(input.limit);
    const page = await this.repository.listSettledNormalizedHeatObservations({
      organizationId: this.#organizationId,
      publicRepackIds: ids,
      occurredAtGte: windows.occurredAtGte,
      occurredAtLt: windows.occurredAtLt,
      causalSequenceLte: maximumSettledCausalSequence,
      limit,
    });
    const observations = validatedPageObservations({
      page,
      knownRepackIds: new Set(ids),
      windows,
      maximumSettledCausalSequence,
      limit,
    });

    return Object.freeze({
      observations: Object.freeze(observations.map(toRepackHeatObservation)),
      sourceCoverageComplete: page.sourceCoverageComplete,
      truncated: page.truncated,
    });
  }
}
