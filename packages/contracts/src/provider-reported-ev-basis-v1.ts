/**
 * Reviewed meaning of the public vendor-reported EV from each source reader.
 * These fields state underlying outcome value before the separate buyback:
 * Phygitals `ev`, Collector Crypt `targetEV`, Courtyard
 * `saleDetails.expectedValueUsd`. Unknown providers must not inherit a basis.
 */
export const PROVIDER_REPORTED_EV_BASIS_V1: Readonly<Record<
  string, "underlying_outcome_value" | undefined
>> = Object.freeze({
  phygitals: "underlying_outcome_value",
  collector_crypt: "underlying_outcome_value",
  courtyard: "underlying_outcome_value",
});
