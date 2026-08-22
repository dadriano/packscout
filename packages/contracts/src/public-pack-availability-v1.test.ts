import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
  canonicalPackAvailabilityInputV1Schema,
  projectCanonicalPackAvailabilityV1,
  publicPackAvailabilityProjectionV1Schema,
} from "./public-pack-availability-v1.ts";

const PUBLIC_REPACK_ID = "00000000-0000-5000-8000-000000000301";
const PUBLIC_VENDOR_ID = "00000000-0000-5000-8000-000000000001";
const SOURCE_UPDATED_AT = "2026-08-20T12:00:00.000Z";

function canonicalInput(
  availability: "available" | "unavailable" | "unknown" | "sold_out",
) {
  return {
    schemaVersion: PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
    publicRepackId: PUBLIC_REPACK_ID,
    publicVendorId: PUBLIC_VENDOR_ID,
    vendorKey: "courtyard",
    availability,
    availabilityProvenance:
      availability === "sold_out"
        ? {
            kind: "explicit_authoritative_sold_out" as const,
            authority: "provider_explicit_sold_out" as const,
          }
        : {
            kind: "canonical_provider_observation" as const,
            observedAvailability: availability,
          },
    sourceUpdatedAt: SOURCE_UPDATED_AT,
  };
}

test("the versioned public handoff preserves every canonical availability unchanged", () => {
  for (const availability of [
    "available",
    "unavailable",
    "unknown",
    "sold_out",
  ] as const) {
    const projected = projectCanonicalPackAvailabilityV1(
      canonicalInput(availability),
    );
    assert.equal(projected.availability, availability);
    assert.equal(projected.publicVendorId, PUBLIC_VENDOR_ID);
    assert.equal(projected.vendorKey, "courtyard");
    assert.equal(projected.sourceUpdatedAt, SOURCE_UPDATED_AT);
    assert.equal(
      publicPackAvailabilityProjectionV1Schema.safeParse(projected).success,
      true,
    );
  }
});

test("sold out requires explicit authoritative canonical provenance", () => {
  assert.equal(
    canonicalPackAvailabilityInputV1Schema.safeParse({
      ...canonicalInput("sold_out"),
      availabilityProvenance: {
        kind: "canonical_provider_observation",
        observedAvailability: "unavailable",
      },
    }).success,
    false,
  );
  assert.equal(
    canonicalPackAvailabilityInputV1Schema.safeParse({
      ...canonicalInput("unavailable"),
      availabilityProvenance: {
        kind: "explicit_authoritative_sold_out",
        authority: "provider_explicit_sold_out",
      },
    }).success,
    false,
  );
  assert.equal(
    canonicalPackAvailabilityInputV1Schema.safeParse({
      ...canonicalInput("unknown"),
      availabilityProvenance: {
        kind: "canonical_provider_observation",
        observedAvailability: "unavailable",
      },
    }).success,
    false,
  );
});

test("the public handoff rejects provider fields and never interprets DataForrest values", () => {
  for (const forbidden of [
    { available: false },
    { sourceInstanceId: "source-1" },
    { connectionId: "connection-1" },
    { credentials: { token: "secret" } },
    { checkpoint: "opaque-cursor" },
    { vendorCursor: "opaque-cursor" },
    { processorDiagnostics: ["failure"] },
    { quarantine: { reason: "invalid" } },
    { rawMarketEvents: [{ amount: 20 }] },
    { paymentMethod: "card" },
    { protectedProviderData: { status: "sold out" } },
  ]) {
    assert.equal(
      canonicalPackAvailabilityInputV1Schema.safeParse({
        ...canonicalInput("unavailable"),
        ...forbidden,
      }).success,
      false,
      Object.keys(forbidden)[0],
    );
  }
  assert.equal(
    canonicalPackAvailabilityInputV1Schema.safeParse({
      ...canonicalInput("unavailable"),
      availability: undefined,
    }).success,
    false,
  );
  assert.equal(
    canonicalPackAvailabilityInputV1Schema.safeParse({
      ...canonicalInput("unavailable"),
      availability: "disabled",
    }).success,
    false,
  );
});
