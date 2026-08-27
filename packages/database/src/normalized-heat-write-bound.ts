export const NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES = 1_000;

export class NormalizedHeatExpandedWriteBoundError extends RangeError {
  readonly code = "NORMALIZED_HEAT_EXPANDED_WRITE_BOUND_EXCEEDED";

  constructor() {
    super("Expanded Heat normalization write exceeds its transaction bound.");
    this.name = "NormalizedHeatExpandedWriteBoundError";
  }
}

export function assertNormalizedHeatExpandedWriteBound(
  candidates: readonly unknown[],
  outcomes: readonly unknown[],
): void {
  if (
    candidates.length + outcomes.length
    > NORMALIZED_HEAT_MAXIMUM_WRITE_CANDIDATES
  ) {
    throw new NormalizedHeatExpandedWriteBoundError();
  }
}
