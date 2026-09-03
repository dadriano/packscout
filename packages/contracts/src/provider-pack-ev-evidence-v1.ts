import { z } from "zod";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  launchProviderKeySchema,
  providerIdentityNamespaceByLaunchProvider,
} from "./provider-source-contract-v1.ts";
import {
  normalizedEvInputFactSchema,
  normalizedMoneyFactSchema,
  normalizedNumberFactSchema,
} from "./provider-source-facts-v1.ts";
import { providerRecordIdentitySchema } from "./provider-source-observation-v1.ts";

export const PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION =
  "provider_pack_ev_evidence_v1" as const;

const versionToken = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u);
const timestamp = z.iso.datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  "provider_pack_ev_evidence.timestamp_not_canonical",
);

/**
 * Private canonical inputs retained with a provider pack for calculation when
 * publishing. This is not a raw source archive or an EV result. The source
 * effective time and authenticated collection time remain distinct; each
 * provider's evidence adapter chooses its supported observation basis.
 * Neither timestamp may be rewritten merely because publication runs again.
 */
export const providerPackEvEvidenceV1Schema = z.object({
  schemaVersion: z.literal(PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION),
  organizationId: z.uuid(),
  providerId: z.uuid(),
  providerKey: launchProviderKeySchema,
  providerRecordId: providerRecordIdentitySchema.shape.providerRecordId,
  recordIdScopeKey: z.literal("catalog-pack-v1"),
  sourceTypeKey: versionToken,
  sourceAdapterVersion: versionToken,
  normalizedContractVersion: z.literal(PROVIDER_OBSERVATION_CONTRACT_VERSION),
  mapperKey: versionToken,
  mapperVersion: versionToken,
  identityNamespaceKey: versionToken,
  effectiveAt: timestamp,
  collectedAt: timestamp,
  price: normalizedMoneyFactSchema,
  buybackPercent: normalizedNumberFactSchema,
  drawCount: normalizedNumberFactSchema,
  evInput: normalizedEvInputFactSchema,
}).strict().superRefine((value, context) => {
  if (
    value.identityNamespaceKey !==
    providerIdentityNamespaceByLaunchProvider[value.providerKey]
  ) {
    context.addIssue({
      code: "custom",
      message: "provider_pack_ev_evidence.identity_namespace_mismatch",
      path: ["identityNamespaceKey"],
    });
  }
  if (Date.parse(value.collectedAt) < Date.parse(value.effectiveAt)) {
    context.addIssue({
      code: "custom",
      message: "provider_pack_ev_evidence.collection_precedes_source",
      path: ["collectedAt"],
    });
  }
});

export type ProviderPackEvEvidenceV1 = z.infer<
  typeof providerPackEvEvidenceV1Schema
>;
