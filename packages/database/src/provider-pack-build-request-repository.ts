import { randomUUID } from "node:crypto";
import {
  PACK_CATALOG_V1, PACK_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, packBuildRequestSchema,
  providerPackBuildInputsSchema, providerPackReadinessSchema, packCatalogTextSchema, packCatalogUuidSchema,
  assertPublicPackCatalogBytes, deriveProviderPackInputDigests, deriveProviderPackProfilePrerequisites, deriveProviderPackReadinessDecision,
  packCatalogCanonicalByteCount, packCatalogCanonicalJson, packPublicationLimits,
  type PackBuildRequest, type ProviderPackBuildInputs, type ProviderPackReadiness,
} from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { ProviderPackPublicationContext, packInvariant, type PackWorkClaim } from "./provider-pack-publication-context.ts";

export interface PackPlanningOutcome {
  publicRepackId: string;
  outcome: "change" | "no_change";
  sequence: string;
  requestId: string;
}

export class ProviderPackBuildRequestRepository {
  constructor(readonly context: ProviderPackPublicationContext) {}

  async enqueueInTransaction(tx: ProviderTransactionClient, input: {
    inputs: ProviderPackBuildInputs; readiness: ProviderPackReadiness; boundaryIdentity: string;
  }): Promise<PackPlanningOutcome> {
    await this.context.assertScope(tx);
    const inputs = providerPackBuildInputsSchema.parse(input.inputs);
    const readiness = providerPackReadinessSchema.parse(input.readiness);
    assertPublicPackCatalogBytes(inputs);
    packInvariant(packCatalogCanonicalByteCount(inputs) <= packPublicationLimits.maximumInputBytes, "PACK_LIMIT_EXCEEDED");
    packInvariant(inputs.providerId === this.context.scope.providerId, "PACK_SCOPE_MISMATCH");
    const digests = await deriveProviderPackInputDigests(inputs);
    for (const key of ["desiredStateSha256", "contentsSha256", "probabilityInputsSha256", "valuationInputsSha256", "evInputsSha256"] as const) {
      packInvariant(readiness[key] === digests[key], "PACK_INPUT_INVALID");
    }
    const requiredProfileSnapshotIds = deriveProviderPackProfilePrerequisites(inputs);
    packInvariant(requiredProfileSnapshotIds.length === readiness.requiredProfileSnapshotIds.length &&
      requiredProfileSnapshotIds.every((id, index) => id === readiness.requiredProfileSnapshotIds[index]), "PACK_INPUT_INVALID");
    if (inputs.snapshotKind === "lifecycle_only") {
      const head = await tx.pack_publication_heads.findUnique({ where: { public_repack_id: inputs.publicRepackId } });
      const artifact = head?.active_snapshot_id ? await tx.pack_snapshot_artifacts.findUnique({ where: { public_pack_snapshot_id: head.active_snapshot_id } }) : null;
      packInvariant(packCatalogCanonicalJson(inputs.lifecycleBaseline) === packCatalogCanonicalJson(artifact?.snapshot_json ?? null), "PACK_INPUT_INVALID");
    }
    const decision = await deriveProviderPackReadinessDecision(inputs, digests.evInputsSha256, (await this.context.now(tx)).toISOString());
    packInvariant((readiness.outcome === decision.outcome || (readiness.outcome === "no_change" && decision.outcome === "ready")) &&
      readiness.reasonCode === decision.reasonCode, "PACK_INPUT_INVALID");
    return this.persist(tx, { publicRepackId: inputs.publicRepackId, digest: readiness.desiredStateSha256,
      state: readiness.outcome, reasonCode: readiness.reasonCode, inputsJson: inputs,
      request: async (head, id, sequence) => {
        const evidence = { providerId: inputs.providerId, publicRepackId: inputs.publicRepackId,
          packPublicationSequence: sequence, providerChangeIdentity: input.boundaryIdentity,
          sourceRevisionIdentity: inputs.sourceRevisionIdentity, sharedDependencies: inputs.expectedDependencies };
        return readiness.outcome === "ready" ? packBuildRequestSchema.parse({
          requestId: id, schemaVersion: PACK_CATALOG_V1, providerId: inputs.providerId, publicRepackId: inputs.publicRepackId,
          packPublicationSequence: sequence, desiredStateSha256: readiness.desiredStateSha256,
          contentsSha256: readiness.contentsSha256, probabilityInputsSha256: readiness.probabilityInputsSha256,
          valuationInputsSha256: readiness.valuationInputsSha256, evInputsSha256: readiness.evInputsSha256,
          profilePrerequisiteMode: head.generation === 0n ? "initial_heads_required" : "existing_heads_accepted",
          requiredProfileSnapshotIds, expectedPublicationEpoch: Number(head.publication_epoch),
          evidence, requestedAt: (await this.context.now(tx)).toISOString(),
        }) : null;
      } });
  }
  /** Persist only a bounded native identity when a candidate cannot enter the public allowlist. */
  async rejectInTransaction(tx: ProviderTransactionClient, input: {
    publicRepackId: string; sourceRevisionIdentity: string; boundaryIdentity: string;
  }): Promise<PackPlanningOutcome> {
    await this.context.assertScope(tx);
    const marker = { providerId: this.context.scope.providerId, publicRepackId: packCatalogUuidSchema.parse(input.publicRepackId),
      sourceRevisionIdentity: packCatalogTextSchema(200).parse(input.sourceRevisionIdentity),
      boundaryIdentity: packCatalogTextSchema(200).parse(input.boundaryIdentity), rejection: "INVALID_DOMAIN_DATA" };
    assertPublicPackCatalogBytes(marker);
    return this.persist(tx, { publicRepackId: marker.publicRepackId, digest: await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, marker),
      state: "blocked", reasonCode: "INVALID_DOMAIN_DATA", inputsJson: marker, request: async () => null });
  }
  private async persist(tx: ProviderTransactionClient, input: {
    publicRepackId: string; digest: string; state: ProviderPackReadiness["outcome"];
    reasonCode: ProviderPackReadiness["reasonCode"]; inputsJson: Prisma.InputJsonValue;
    request: (head: { generation: bigint; publication_epoch: bigint }, id: string, sequence: string) => Promise<PackBuildRequest | null>;
  }): Promise<PackPlanningOutcome> {
    const publicRepackId = input.publicRepackId;
    await tx.pack_publication_heads.upsert({ where: { public_repack_id: publicRepackId },
      create: { ...this.context.where, public_repack_id: publicRepackId }, update: {} });
    await tx.$queryRaw`SELECT public_repack_id FROM pack_publication_heads WHERE public_repack_id = ${publicRepackId}::uuid FOR UPDATE`;
    const head = await tx.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: publicRepackId } });
    packInvariant(head.organization_id === this.context.scope.organizationId && head.provider_id === this.context.scope.providerId, "PACK_SCOPE_MISMATCH");
    const previous = await tx.pack_build_requests.findUnique({ where: { public_repack_id_pack_publication_sequence: {
      public_repack_id: publicRepackId, pack_publication_sequence: head.latest_sequence } }, include: { activation: { select: { state: true } } } });
    // A digest identifies desired bytes, not an eternal episode. A -> B -> A
    // needs a new sequence; neither superseded work nor its intent is reopened.
    if (previous?.desired_state_sha256 === input.digest && previous.expected_publication_epoch === head.publication_epoch &&
      !["superseded", "rolled_back"].includes(previous.state) && !["superseded", "rolled_back"].includes(previous.activation?.state ?? "")) {
      return { publicRepackId, outcome: "no_change", sequence: previous.pack_publication_sequence.toString(), requestId: previous.id };
    }
    packInvariant(["ready", "waiting", "blocked"].includes(input.state), "PACK_INPUT_INVALID");
    const [allocation] = await tx.$queryRaw<Array<{ sequence: bigint }>>`SELECT nextval('pack_build_requests_pack_publication_sequence_seq') AS sequence`;
    const sequence = allocation!.sequence.toString();
    const id = randomUUID();
    // A pending desired state may not know its profile prerequisites yet. Only a
    // fully pinned ready request is an assembly command; pending rows are never claimable.
    const request = await input.request(head, id, sequence);
    await tx.pack_build_requests.create({ data: { ...this.context.where, id, public_repack_id: publicRepackId,
      pack_publication_sequence: allocation!.sequence, desired_state_sha256: input.digest,
      expected_publication_epoch: head.publication_epoch,
      request_json: request ?? Prisma.JsonNull, inputs_json: input.inputsJson, state: input.state, reason_code: input.reasonCode } });
    // Claimed work retains its episode until its owner releases or its lease expires.
    await tx.$executeRaw`UPDATE pack_build_requests SET state = 'superseded'
      WHERE public_repack_id = ${publicRepackId}::uuid AND pack_publication_sequence < ${allocation!.sequence}
      AND state IN ('waiting','ready','retry_scheduled','blocked') AND id IS DISTINCT FROM ${head.lease_work_id}::uuid`;
    await tx.$executeRaw`UPDATE pack_activation_intents SET state = 'superseded'
      WHERE public_repack_id = ${publicRepackId}::uuid AND pack_publication_sequence < ${allocation!.sequence}
      AND state IN ('waiting','ready','retry_scheduled','blocked') AND id IS DISTINCT FROM ${head.lease_work_id}::uuid`;
    await tx.pack_publication_heads.update({ where: { public_repack_id: publicRepackId }, data: { latest_sequence: allocation!.sequence } });
    return { publicRepackId, outcome: "change", sequence, requestId: id };
  }
  claim(owner: string, limit = 1) { return this.context.claim("build", owner, limit); }
  renew(claim: PackWorkClaim) { return this.context.renew(claim); }
  async load(claim: PackWorkClaim): Promise<{ request: PackBuildRequest; inputs: ProviderPackBuildInputs }> {
    return this.context.transaction(async tx => {
      await this.context.lockLease(tx, claim, "build");
      const row = await tx.pack_build_requests.findUniqueOrThrow({ where: { id: claim.workId } });
      return { request: packBuildRequestSchema.parse(row.request_json), inputs: providerPackBuildInputsSchema.parse(row.inputs_json) };
    });
  }
}
