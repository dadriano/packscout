import { z } from "zod";
import { canonicalJson } from "./data-release-v2-canonical.ts";
import {
  packScoutBuybackEvMetricsAreConsistentV1,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvTimestampV1Schema,
} from "./buyback-adjusted-ev-v1.ts";
import { packScoutPublicEvV3Schema } from "./data-release-v3-ev-estimates.ts";
import { publicPackAvailabilitySchema } from "./public-pack-availability-v1.ts";
import { publicRepackIdSchema, publicVendorIdSchema, publicVendorKeySchema } from "./data-release-v2-values.ts";

/** Narrow authenticated publication verification, never a public catalog read. */
export const MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_SCOPES = 100;
export const MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES = 512 * 1_024;
export const DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN =
  "packscout.data-release-v3.retained-ev-witness.v1";

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const scope = z.object({ vendorKey: publicVendorKeySchema,
  publicVendorId: publicVendorIdSchema, publicRepackId: publicRepackIdSchema }).strict();
const scopes = z.array(scope).min(1).max(MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_SCOPES)
  .refine((items) => new Set(items.map((item) => item.publicRepackId)).size === items.length);
const retention = z.object({ operationId: z.string().min(1).max(128),
  direction: z.enum(["forward", "reverse"]), changesSha256: hash }).strict();

export const dataReleaseV3RetainedEvWitnessReadinessRequestSchema = z.object({
  expectedActivePublicReleaseId: z.uuid().nullable(),
  expectedActiveReleaseFingerprint: hash.nullable(),
  expectedGeneration: z.number().int().safe().min(0),
}).strict().refine((value) => (value.expectedActivePublicReleaseId === null) ===
  (value.expectedActiveReleaseFingerprint === null));

export const dataReleaseV3RetainedEvWitnessReadinessSchema = z.object({
  generation: z.number().int().safe().min(0),
  activePublicReleaseId: z.uuid().nullable(), activeReleaseFingerprint: hash.nullable(),
  retention: retention.nullable(),
}).strict().refine((value) => value.activePublicReleaseId === null
  ? value.activeReleaseFingerprint === null && value.retention === null && value.generation === 0
  : value.activeReleaseFingerprint !== null && value.retention !== null && value.generation > 0);

export const dataReleaseV3RetainedEvWitnessRequestSchema = z.object({
  expectedActivePublicReleaseId: z.uuid(),
  expectedActiveReleaseFingerprint: hash,
  expectedGeneration: z.number().int().safe().min(1),
  scopes,
}).strict();

const facts = z.object({ availability: publicPackAvailabilitySchema,
  calculationPriceUsdMinor: z.number().int().safe().nonnegative().nullable(),
  estimate: packScoutPublicEvV3Schema,
}).strict();
const retained = z.object({
  estimate: packScoutPublicEvV3Schema,
  calculationPriceUsdMinor: z.number().int().safe().positive(),
  sourcePublicReleaseId: z.uuid(),
  latestUnavailableAttempt: z.object({ calculatedAt: packScoutBuybackEvTimestampV1Schema,
    reason: packScoutBuybackEvPublicReasonCodeV1Schema }).strict().nullable(),
}).strict().refine((value) => value.estimate.status !== "unavailable" &&
  (value.latestUnavailableAttempt === null ||
    Date.parse(value.latestUnavailableAttempt.calculatedAt) > Date.parse(value.estimate.calculatedAt)));

function economicsValid(value: z.infer<typeof facts> | z.infer<typeof retained>): boolean {
  const estimate = value.estimate;
  if (estimate.status === "unavailable") return true;
  return value.calculationPriceUsdMinor !== null && value.calculationPriceUsdMinor > 0 &&
    packScoutBuybackEvMetricsAreConsistentV1({
      grossEvMinorUnits: estimate.metrics.grossEvMoney.minorUnits,
      grossReturnBasisPoints: estimate.metrics.grossReturnBasisPoints,
      evDollarsMinorUnits: estimate.metrics.evDollars.minorUnits,
      evPercentBasisPoints: estimate.metrics.evPercentBasisPoints,
      packPriceMinorUnits: value.calculationPriceUsdMinor,
    });
}

export const dataReleaseV3RetainedEvWitnessSchema = z.object({
  generation: z.number().int().safe().min(1),
  activePublicReleaseId: z.uuid(), activeReleaseFingerprint: hash,
  retention,
  entries: z.array(scope.extend({ activeFacts: facts, retained: retained.nullable() }).strict())
    .min(1).max(MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_SCOPES),
  witnessSha256: hash,
}).strict().refine((value) =>
  new Set(value.entries.map((entry) => entry.publicRepackId)).size === value.entries.length &&
  value.entries.every((entry) => economicsValid(entry.activeFacts) &&
    (entry.retained === null ? entry.activeFacts.estimate.status === "unavailable" : economicsValid(entry.retained))));

/** Includes the full receipt when enforced at the signed server/client boundary. */
export function dataReleaseV3RetainedEvWitnessWithinByteLimit(value: unknown): boolean {
  return new TextEncoder().encode(canonicalJson(value)).byteLength <= MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES;
}

export type DataReleaseV3RetainedEvWitnessRequest = z.infer<typeof dataReleaseV3RetainedEvWitnessRequestSchema>;
export type DataReleaseV3RetainedEvWitness = z.infer<typeof dataReleaseV3RetainedEvWitnessSchema>;
export type DataReleaseV3RetainedEvWitnessReadinessRequest = z.infer<typeof dataReleaseV3RetainedEvWitnessReadinessRequestSchema>;
export type DataReleaseV3RetainedEvWitnessReadiness = z.infer<typeof dataReleaseV3RetainedEvWitnessReadinessSchema>;
