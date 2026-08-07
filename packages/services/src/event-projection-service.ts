import { createHmac } from "node:crypto";
import {
  CanonicalProjectionValidationError,
  normalizeCanonicalIdentity,
  normalizeCanonicalMoney,
  normalizeCanonicalTimestamp,
  normalizeOptionalText,
} from "./canonical-projection-validation.ts";
import type {
  ProviderRelationshipKey,
  PseudonymousActorInput,
  PullCandidate,
  SaleCandidate,
} from "./provider-adapter.ts";
import type {
  ProviderCanonicalProjectionCommand,
  ProviderCanonicalRelationshipCommand,
  ProviderProjectionOutcome,
  ProviderProjectionPort,
} from "./provider-import-types.ts";

export type CanonicalSaleCategory =
  | "buyback"
  | "listing"
  | "mint"
  | "other"
  | "sale"
  | "shipment"
  | "transfer"
  | "unlisting";

export interface ProviderActorPseudonymizer {
  pseudonymize(input: {
    readonly providerId: string;
    readonly platformKey: string;
    readonly role: PseudonymousActorInput["role"];
    readonly namespace: string;
    readonly sourceIdentifier: string;
  }): string;
}

export class HmacProviderActorPseudonymizer
  implements ProviderActorPseudonymizer
{
  readonly #key: Buffer;

  constructor(key: Uint8Array | string) {
    const normalized = Buffer.from(key);
    if (normalized.byteLength < 32) {
      throw new Error("Provider actor pseudonym key must be at least 32 bytes.");
    }
    this.#key = normalized;
  }

  pseudonymize(input: {
    providerId: string;
    platformKey: string;
    role: PseudonymousActorInput["role"];
    namespace: string;
    sourceIdentifier: string;
  }): string {
    const providerId = normalizeCanonicalIdentity(
      input.providerId,
      "configuration.providerId",
      128,
    );
    const platformKey = normalizeCanonicalIdentity(
      input.platformKey,
      "source.platform",
      128,
    );
    const namespace = normalizeCanonicalIdentity(
      input.namespace,
      "pseudonymization.namespace",
      128,
    );
    const sourceIdentifier = normalizeCanonicalIdentity(
      input.sourceIdentifier,
      "pseudonymization.sourceIdentifier",
      1_024,
    );
    return `actor:v1:${createHmac("sha256", this.#key)
      .update(
        `${providerId}\u0000${platformKey}\u0000${namespace}\u0000${input.role}\u0000${sourceIdentifier}`,
      )
      .digest("hex")}`;
  }
}

function categoryForProviderEvent(value: string): CanonicalSaleCategory {
  const normalized = value.trim().toLowerCase().replaceAll(/[-\s]/g, "_");
  const categories: Readonly<Record<string, CanonicalSaleCategory>> = {
    buy: "buyback",
    buyback: "buyback",
    listing: "listing",
    mint: "mint",
    minted: "mint",
    sale: "sale",
    shipped: "shipment",
    shipment: "shipment",
    transfer: "transfer",
    unlisting: "unlisting",
  };
  return categories[normalized] ?? "other";
}

function invalid(
  reasonCode: string,
  fieldPath?: string,
): ProviderProjectionOutcome {
  return {
    status: "invalid",
    reasonCode,
    ...(fieldPath ? { fieldPath } : {}),
  };
}

function actorKeys(
  candidate: PullCandidate | SaleCandidate,
  providerId: string,
  pseudonymizer: ProviderActorPseudonymizer,
): Readonly<Record<PseudonymousActorInput["role"], string>> {
  const result: Partial<Record<PseudonymousActorInput["role"], string>> = {};
  for (const actor of candidate.pseudonymizationInputs) {
    if (result[actor.role] !== undefined) {
      throw new CanonicalProjectionValidationError(
        "INVALID_IDENTITY",
        `pseudonymization.${actor.role}`,
      );
    }
    result[actor.role] = pseudonymizer.pseudonymize({
      providerId,
      platformKey: candidate.source.platform,
      role: actor.role,
      namespace: actor.namespace,
      sourceIdentifier: actor.sourceIdentifier,
    });
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
    ),
  ) as Readonly<Record<PseudonymousActorInput["role"], string>>;
}

function relationshipCommand(
  relationship: ProviderRelationshipKey,
): ProviderCanonicalRelationshipCommand | null {
  if (relationship.externalId === null) return null;
  return {
    relationshipKind: relationship.relationship,
    targetPlatformKey: normalizeCanonicalIdentity(
      relationship.platform,
      "relationships.platform",
      128,
    ),
    targetRecordKind:
      relationship.entityKind === "pack" ? "pack" : "catalog_asset",
    targetExternalId: normalizeCanonicalIdentity(
      relationship.externalId,
      "relationships.externalId",
    ),
  };
}

function relationshipsForEvent(
  candidate: PullCandidate | SaleCandidate,
): readonly ProviderCanonicalRelationshipCommand[] {
  const relationships = candidate.relationships
    .map(relationshipCommand)
    .filter(
      (relationship): relationship is ProviderCanonicalRelationshipCommand =>
        relationship !== null,
    );
  const packExternalId = candidate.packExternalId ?? null;
  if (packExternalId !== null) {
    relationships.push({
      relationshipKind: "subject",
      targetPlatformKey: candidate.source.platform,
      targetRecordKind: "pack",
      targetExternalId: normalizeCanonicalIdentity(
        packExternalId,
        "packExternalId",
      ),
    });
  }
  if (candidate.assetExternalId !== null) {
    relationships.push({
      relationshipKind: "asset",
      targetPlatformKey: candidate.source.platform,
      targetRecordKind: "catalog_asset",
      targetExternalId: normalizeCanonicalIdentity(
        candidate.assetExternalId,
        "assetExternalId",
      ),
    });
  }
  const unique = new Map<string, ProviderCanonicalRelationshipCommand>();
  for (const relationship of relationships) {
    const key = [
      relationship.relationshipKind,
      relationship.targetPlatformKey,
      relationship.targetRecordKind,
      relationship.targetExternalId,
    ].join("\u0000");
    unique.set(key, relationship);
  }
  return Object.freeze([...unique.values()]);
}

function qualityEvidence(candidate: PullCandidate | SaleCandidate) {
  return candidate.dataQualityEvidence.map((evidence) => ({
    code: normalizeCanonicalIdentity(evidence.code, "quality.code", 128),
    severity: evidence.severity,
    fieldPath: normalizeOptionalText(evidence.fieldPath, "quality.fieldPath", 256),
  }));
}

function commonProjection(
  candidate: PullCandidate | SaleCandidate,
  providerId: string,
  adapterKey: string,
  pseudonymizer: ProviderActorPseudonymizer,
) {
  const occurredAt = normalizeCanonicalTimestamp(
    candidate.occurredAt,
    "occurredAt",
  );
  const collectedAt = normalizeCanonicalTimestamp(
    candidate.source.collectedAt,
    "source.collectedAt",
  );
  return {
    externalId: normalizeCanonicalIdentity(
      candidate.source.externalId,
      "source.externalId",
    ),
    occurredAt,
    collectedAt,
    actors: actorKeys(candidate, providerId, pseudonymizer),
    relationships: relationshipsForEvent(candidate),
    provenance: {
      adapterKey,
      mappingVersion: adapterKey,
      providerId,
      sourceRecordKind: candidate.source.recordKind,
      sourceExternalId: candidate.source.externalId,
      sourceRecordIndex: candidate.source.recordIndex,
      qualityEvidence: qualityEvidence(candidate),
    },
  };
}

export class EventProjectionService implements ProviderProjectionPort {
  constructor(private readonly pseudonymizer: ProviderActorPseudonymizer) {}

  project(
    input: Parameters<ProviderProjectionPort["project"]>[0],
  ): ProviderProjectionOutcome {
    if (input.candidates.length !== 1) {
      return invalid("EVENT_CANDIDATE_SET_INVALID", "candidates");
    }
    const [candidate] = input.candidates;
    if (!candidate || (candidate.candidateKind !== "pull" && candidate.candidateKind !== "sale")) {
      return invalid("EVENT_CANDIDATE_KIND_INVALID", "candidates[0].candidateKind");
    }
    if (
      candidate.source.platform !== input.source.platform ||
      candidate.source.externalId !== input.source.externalId ||
      candidate.source.recordKind !== input.source.recordKind ||
      candidate.source.recordIndex !== input.source.recordIndex ||
      candidate.source.recordKind !== candidate.candidateKind
    ) {
      return invalid("EVENT_SOURCE_MISMATCH", "candidates[0].source");
    }
    try {
      const common = commonProjection(
        candidate,
        input.configuration.providerId,
        input.configuration.adapterKey,
        this.pseudonymizer,
      );
      const projection: ProviderCanonicalProjectionCommand =
        candidate.candidateKind === "pull"
          ? {
              platformKey: input.source.platform,
              recordKind: "pull",
              externalId: common.externalId,
              sourceUpdatedAt: common.occurredAt,
              sourceCollectedAt: common.collectedAt,
              relationships: common.relationships,
              provenance: common.provenance,
              content: {
                eventKind: "pull",
                occurredAt: common.occurredAt.toISOString(),
                collectedAt: common.collectedAt.toISOString(),
                packExternalId: candidate.packExternalId ?? null,
                assetExternalId: candidate.assetExternalId,
                value: normalizeCanonicalMoney(candidate.value, "value"),
                valueSource: normalizeOptionalText(
                  candidate.valueSource,
                  "valueSource",
                  128,
                ),
                actorKeys: common.actors,
              },
            }
          : {
              platformKey: input.source.platform,
              recordKind: "sale",
              externalId: common.externalId,
              sourceUpdatedAt: common.occurredAt,
              sourceCollectedAt: common.collectedAt,
              relationships: common.relationships,
              provenance: common.provenance,
              content: {
                eventKind: "sale",
                providerEventType: normalizeCanonicalIdentity(
                  candidate.eventType,
                  "eventType",
                  128,
                ),
                eventCategory: categoryForProviderEvent(candidate.eventType),
                transactionKey: normalizeCanonicalIdentity(
                  candidate.transactionKey,
                  "transactionKey",
                  512,
                ),
                occurredAt: common.occurredAt.toISOString(),
                collectedAt: common.collectedAt.toISOString(),
                packExternalId: candidate.packExternalId ?? null,
                assetExternalId: candidate.assetExternalId,
                amount: normalizeCanonicalMoney(candidate.amount, "amount"),
                actorKeys: common.actors,
              },
            };
      return { status: "accepted", projections: [projection] };
    } catch (error) {
      if (error instanceof CanonicalProjectionValidationError) {
        return invalid(`EVENT_${error.code}`, error.fieldPath);
      }
      return invalid("EVENT_PROJECTION_FAILED");
    }
  }
}
