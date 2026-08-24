import { createHash } from "node:crypto";
import {
  providerSourceCanonicalCatalogAssetContentV1Schema,
  providerSourceCanonicalEvInputContentV1Schema,
  providerSourceCanonicalMarketEventContentV1Schema,
  providerSourceCanonicalPackContentV1Schema,
  providerSourceCanonicalPullContentV1Schema,
} from "@packscout/contracts";
import { normalizeCanonicalMoney } from "./canonical-projection-validation.ts";
import { CATALOG_PROJECTION_VERSION } from "./catalog-projection-contracts.ts";
import { projectEvInputContent } from "./catalog-ev-input-projection.ts";
import type { EvInputCandidate } from "./provider-adapter.ts";
import type {
  CanonicalEvInputCandidate,
  CanonicalProviderCandidate,
} from "./provider-observation-mapper.ts";
import { normalizeTradeLifecycleEvidence } from "./provider-stream-normalization.ts";

export type ProviderObservationCanonicalCandidate =
  | CanonicalProviderCandidate
  | CanonicalEvInputCandidate;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

function evInputContent(candidate: CanonicalEvInputCandidate) {
  const declaredCoverage = Number(
    candidate.buckets
      .reduce((sum, bucket) => sum + bucket.probability, 0)
      .toFixed(12),
  );
  const projected = projectEvInputContent(
    {
      candidateKind: "ev_input",
      source: {
        platform: candidate.identity.provider,
        recordKind: "catalog",
        recordIndex: 0,
        externalId: candidate.identity.providerRecordId,
        collectedAt: candidate.effectiveAt,
        sourceTimestamp: candidate.effectiveAt,
      },
      externalId: candidate.identity.providerRecordId,
      packExternalId: candidate.affectedPack.providerRecordId,
      currency: candidate.currency,
      unitBasis: candidate.unitBasis,
      drawCount: candidate.drawCount,
      declaredCoverage,
      evidenceCompleteness: "complete",
      buckets: candidate.buckets.map((bucket) => ({
        bucketId: bucket.bucketId,
        evidenceKind: "probability_bucket" as const,
        label: bucket.label,
        probability: bucket.probability,
        lowerValue: bucket.lowerValue,
        upperValue: bucket.upperValue,
      })),
      relationships: [],
      dataQualityEvidence: [],
    } satisfies EvInputCandidate,
    [],
  );
  return Object.freeze(providerSourceCanonicalEvInputContentV1Schema.parse({
    ...projected,
    buybackPercent: candidate.buybackPercent,
    inventory: Object.freeze({
      totalQuantity: candidate.totalQuantity,
      bucketQuantities: Object.freeze(
        candidate.buckets.map((bucket) =>
          Object.freeze({
            bucketId: bucket.bucketId,
            quantity: bucket.quantity,
          }),
        ),
      ),
    }),
  }));
}

/**
 * Exact source-neutral content persisted by the normalized importer. Delivery,
 * source ownership and effective revision time are deliberately outside it.
 */
export function canonicalProviderObservationContent(
  candidate: ProviderObservationCanonicalCandidate,
): Readonly<Record<string, unknown>> {
  if (candidate.candidateKind === "ev_input") return evInputContent(candidate);
  if (candidate.candidateKind === "pack") {
    const price = normalizeCanonicalMoney(candidate.price, "pack.price");
    const providerEv = normalizeCanonicalMoney(
      candidate.providerReportedEv,
      "pack.providerReportedEv",
    );
    return Object.freeze(providerSourceCanonicalPackContentV1Schema.parse({
      schemaVersion: CATALOG_PROJECTION_VERSION,
      entityType: "pack",
      evInputStatus: candidate.evInputStatus,
      parentExternalId: null,
      firstSeenAt: candidate.firstSeenAt,
      name: candidate.displayName,
      category: candidate.category,
      description: candidate.description,
      availability: candidate.availability,
      availabilityProvenance: candidate.availability === "sold_out"
        ? Object.freeze({
            kind: "explicit_authoritative_sold_out" as const,
            authority: "provider_explicit_sold_out" as const,
          })
        : Object.freeze({
            kind: "canonical_provider_observation" as const,
            observedAvailability: candidate.availability,
          }),
      sourceStatus: null,
      priceValueMinor: price?.amountMinor ?? null,
      priceCurrency: price?.currency ?? null,
      providerReportedEvValueMinor: providerEv?.amountMinor ?? null,
      providerReportedEvCurrency: providerEv?.currency ?? null,
      buybackPercent: candidate.buybackPercent,
      drawCount: candidate.drawCount,
      imageUrls: candidate.imageReferences,
      dataQualityEvidence: [],
    }));
  }
  if (candidate.candidateKind === "catalog_asset") {
    const value = normalizeCanonicalMoney(
      candidate.estimatedValue,
      "catalogAsset.estimatedValue",
    );
    return Object.freeze(
      providerSourceCanonicalCatalogAssetContentV1Schema.parse({
      schemaVersion: CATALOG_PROJECTION_VERSION,
      entityType: "catalog_asset",
      assetType: candidate.assetType,
      relatedPackExternalId: null,
      parentExternalId: null,
      firstSeenAt: candidate.firstSeenAt,
      name: candidate.displayName,
      description: candidate.description,
      category: candidate.category,
      availability: candidate.availability,
      sourceStatus: null,
      providerValueMinor: value?.amountMinor ?? null,
      providerValueCurrency: value?.currency ?? null,
      valueSource: candidate.valueSource,
      imageUrls: candidate.imageReferences,
      dataQualityEvidence: [],
      }),
    );
  }
  if (candidate.candidateKind === "pull") {
    return Object.freeze(providerSourceCanonicalPullContentV1Schema.parse({
      eventKind: "pull",
      displayName: candidate.displayName,
      imageUrls: candidate.imageReferences,
      value: normalizeCanonicalMoney(candidate.value, "pull.value"),
      valueSource: candidate.valueSource,
    }));
  }
  const amount = candidate.amount === null || candidate.currency === null
    ? null
    : normalizeCanonicalMoney(
        { amount: candidate.amount, currency: candidate.currency },
        "marketEvent.amount",
      );
  return Object.freeze(providerSourceCanonicalMarketEventContentV1Schema.parse({
    eventKind: "market_event",
    providerEventType: candidate.eventType,
    eventCategory: normalizeTradeLifecycleEvidence(candidate.eventType)
      .canonicalCategory,
    amount,
    paymentMethod: candidate.paymentMethod,
    displayName: candidate.displayName,
    imageUrls: candidate.imageReferences,
  }));
}

export function fingerprintCanonicalProviderContent(
  candidate: ProviderObservationCanonicalCandidate,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(canonicalProviderObservationContent(candidate))))
    .digest("hex");
}
