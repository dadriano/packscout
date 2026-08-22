import { z } from "zod";
import {
  publicRepackIdSchema,
  publicVendorIdSchema,
  publicVendorKeySchema,
  timestampSchema,
} from "./data-release-v2-values.ts";

export const PUBLIC_PACK_AVAILABILITY_INPUT_VERSION =
  "canonical-pack-availability-input-v1" as const;
export const PUBLIC_PACK_AVAILABILITY_PROJECTION_VERSION =
  "public-pack-availability-v1" as const;

export const publicPackAvailabilities = [
  "available",
  "unavailable",
  "unknown",
  "sold_out",
] as const;

export const publicPackAvailabilitySchema = z.enum(publicPackAvailabilities);

const observedAvailabilityProvenanceSchema = z
  .object({
    kind: z.literal("canonical_provider_observation"),
    observedAvailability: z.enum(["available", "unavailable", "unknown"]),
  })
  .strict();

const authoritativeSoldOutProvenanceSchema = z
  .object({
    kind: z.literal("explicit_authoritative_sold_out"),
    authority: z.literal("provider_explicit_sold_out"),
  })
  .strict();

export const canonicalPackAvailabilityInputV1Schema = z
  .object({
    schemaVersion: z.literal(PUBLIC_PACK_AVAILABILITY_INPUT_VERSION),
    publicRepackId: publicRepackIdSchema,
    publicVendorId: publicVendorIdSchema,
    vendorKey: publicVendorKeySchema,
    availability: publicPackAvailabilitySchema,
    availabilityProvenance: z.union([
      observedAvailabilityProvenanceSchema,
      authoritativeSoldOutProvenanceSchema,
    ]),
    sourceUpdatedAt: timestampSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.availability === "sold_out") {
      if (
        input.availabilityProvenance.kind !== "explicit_authoritative_sold_out"
      ) {
        context.addIssue({
          code: "custom",
          path: ["availabilityProvenance"],
          message: "public_availability.sold_out_authority_required",
        });
      }
      return;
    }

    if (
      input.availabilityProvenance.kind !== "canonical_provider_observation" ||
      input.availabilityProvenance.observedAvailability !== input.availability
    ) {
      context.addIssue({
        code: "custom",
        path: ["availabilityProvenance"],
        message: "public_availability.provenance_mismatch",
      });
    }
  });

export const publicPackAvailabilityProjectionV1Schema = z
  .object({
    schemaVersion: z.literal(PUBLIC_PACK_AVAILABILITY_PROJECTION_VERSION),
    publicRepackId: publicRepackIdSchema,
    publicVendorId: publicVendorIdSchema,
    vendorKey: publicVendorKeySchema,
    availability: publicPackAvailabilitySchema,
    sourceUpdatedAt: timestampSchema,
  })
  .strict();

/**
 * Source-neutral handoff for the future canonical-to-public publisher.
 *
 * This validates canonical provenance and deliberately performs no provider
 * field interpretation: the exact canonical availability is copied unchanged.
 */
export function projectCanonicalPackAvailabilityV1(
  value: unknown,
): PublicPackAvailabilityProjectionV1 {
  const input = canonicalPackAvailabilityInputV1Schema.parse(value);
  return publicPackAvailabilityProjectionV1Schema.parse({
    schemaVersion: PUBLIC_PACK_AVAILABILITY_PROJECTION_VERSION,
    publicRepackId: input.publicRepackId,
    publicVendorId: input.publicVendorId,
    vendorKey: input.vendorKey,
    availability: input.availability,
    sourceUpdatedAt: input.sourceUpdatedAt,
  });
}

export type PublicPackAvailability = z.infer<
  typeof publicPackAvailabilitySchema
>;
export type CanonicalPackAvailabilityInputV1 = z.infer<
  typeof canonicalPackAvailabilityInputV1Schema
>;
export type PublicPackAvailabilityProjectionV1 = z.infer<
  typeof publicPackAvailabilityProjectionV1Schema
>;
