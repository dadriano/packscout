import {
  PACK_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, packCatalogTextSchema, packCatalogUuidSchema,
  packPublicationLimits, sharedProviderChangeDeliverySchema, providerPackBuildInputsSchema,
  assertPublicPackCatalogBytes, packCatalogCanonicalByteCount,
  type ProviderPackBuildInputs, type ProviderPackReadiness, type SharedProviderChangeDelivery,
} from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { ProviderPackBuildRequestRepository, type PackPlanningOutcome } from "./provider-pack-build-request-repository.ts";
import { ProviderPackPublicationContext, packInvariant } from "./provider-pack-publication-context.ts";

export interface PackInputCapture {
  /** P06 binds native/profile/EV readers here after P03/P04 land. Read only through
   * this transaction with bounded selects; never perform network I/O or calculate EV.
   * Include the delivered dependency vector (including missing observed revisions).
   * Return allowlisted public inputs, not raw rows, attributes, instances, or source evidence.
   * The repository persists these full bytes before releasing the transaction. */
  capture(tx: ProviderTransactionClient, input: {
    providerId: string; publicRepackId: string; sourceRevisionIdentity: string;
    sharedDependencies: SharedProviderChangeDelivery["sharedDependencies"];
  }): Promise<ProviderPackBuildInputs>;
  evaluate(input: { candidate: ProviderPackBuildInputs; evaluatedAt: string;
    previousSnapshot?: import("@packscout/contracts").PublicPackSnapshot | null;
  }): Promise<{ inputs: ProviderPackBuildInputs; readiness: ProviderPackReadiness }>;
}
export interface PackImpactResult {
  boundaryIdentity: string;
  complete: boolean;
  acknowledgmentDigest: string | null;
  outcomes: PackPlanningOutcome[];
}

/** Consumes the native, transactional change ledger; no legacy ingestion adapter. */
export class ProviderPackImpactRepository {
  readonly #requests: ProviderPackBuildRequestRepository;
  constructor(readonly context: ProviderPackPublicationContext, readonly capture: PackInputCapture) {
    this.#requests = new ProviderPackBuildRequestRepository(context);
  }
  async plan(input: { kind: "provider" } | { kind: "shared"; delivery: SharedProviderChangeDelivery }): Promise<PackImpactResult | null> {
    packInvariant(["provider", "shared"].includes(input.kind), "PACK_INPUT_INVALID");
    const delivery = input.kind === "shared" ? sharedProviderChangeDeliverySchema.parse(input.delivery) : null;
    if (delivery) packInvariant(delivery.organizationId === this.context.scope.organizationId && delivery.providerId === this.context.scope.providerId, "PACK_SCOPE_MISMATCH");
    return this.context.transaction(async tx => {
      await tx.$queryRaw`SELECT provider_id FROM pack_publication_scopes WHERE provider_id = ${this.context.scope.providerId}::uuid FOR UPDATE`;
      const scope = await tx.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: this.context.scope.providerId } });
      const pending = delivery ? null : await tx.pack_publication_impact_progress.findFirst({ where: {
        ...this.context.where, through_sequence: { not: null }, complete: false } });
      const changes = delivery || pending ? [] : await tx.promotion_changes.findMany({ where: { sequence: { gt: scope.change_sequence } },
        orderBy: { sequence: "asc" }, take: packPublicationLimits.changePage });
      if (!delivery && !pending && changes.length === 0) return null;
      const boundaryIdentity = packCatalogTextSchema(200).parse(pending?.boundary_identity ?? (delivery ? `shared:${delivery.centralChangeIdentity}`
        : `provider:${scope.change_sequence}:${changes.at(-1)!.sequence}`));
      const boundary = delivery ? { organizationId: delivery.organizationId, providerId: delivery.providerId,
        centralChangeIdentity: delivery.centralChangeIdentity, providerChangeSequence: delivery.providerChangeSequence,
        sharedDependencies: delivery.sharedDependencies, payloadSha256: delivery.payloadSha256 }
        : changes.map(row => ({ sequence: row.sequence.toString(), kind: row.entity_type, id: row.entity_id,
          version: row.entity_version.toString(), operation: row.operation }));
      const boundarySha256 = pending?.boundary_sha256 ?? await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, boundary);
      let progress = pending ?? await tx.pack_publication_impact_progress.findUnique({ where: {
        organization_id_provider_id_boundary_identity: { ...this.context.where, boundary_identity: boundaryIdentity } } });
      if (progress) {
        packInvariant(progress.boundary_sha256 === boundarySha256);
        if (progress.complete) return { boundaryIdentity, complete: true, acknowledgmentDigest: progress.result_sha256, outcomes: [] };
      }
      if (delivery && !progress) {
        // Shared deliveries are ordered per provider by P04. Never let an older
        // dependency episode replace a newer desired state or skip an unfinished shard.
        packInvariant(BigInt(delivery.providerChangeSequence) > scope.shared_change_sequence);
        packInvariant(!await tx.pack_publication_impact_progress.findFirst({ where: {
          ...this.context.where, shared_sequence: { not: null }, complete: false } }));
      }
      const references = progress ? progress.references_json as unknown as Array<{ kind: string; id: string }> : delivery ? delivery.sharedDependencies.map(dependency => ({
        kind: dependency.kind === "collectible_profile" || dependency.kind === "valuation" ? "collectible" : dependency.kind,
        id: dependency.identity,
      })) : changes.map(row => ({ kind: row.entity_type, id: row.entity_id }));
      progress ??= await tx.pack_publication_impact_progress.create({ data: { ...this.context.where,
        boundary_identity: boundaryIdentity, boundary_sha256: boundarySha256, references_json: references,
        result_sha256: boundarySha256, through_sequence: delivery ? null : changes.at(-1)!.sequence,
        shared_sequence: delivery ? BigInt(delivery.providerChangeSequence) : null } });
      const packIds = await this.affected(tx, references, progress.after_pack_id);
      let complete = packIds.length <= packPublicationLimits.affectedPacks;
      const page = packIds.slice(0, packPublicationLimits.affectedPacks);
      const outcomes: PackPlanningOutcome[] = [];
      let capturedBytes = 0;
      const evaluatedAt = (await this.context.now(tx)).toISOString();
      for (const publicRepackId of page) {
        const pack = await tx.packs.findUniqueOrThrow({ where: { id: publicRepackId }, select: { row_version: true } });
        const sourceRevisionIdentity = `pack:${publicRepackId}:${pack.row_version}:${boundarySha256}`;
        const candidate = await this.capture.capture(tx, { providerId: this.context.scope.providerId, publicRepackId,
          sourceRevisionIdentity, sharedDependencies: delivery?.sharedDependencies ?? [] });
        packInvariant(candidate.publicRepackId === publicRepackId && candidate.providerId === this.context.scope.providerId &&
          candidate.sourceRevisionIdentity === sourceRevisionIdentity, "PACK_SCOPE_MISMATCH");
        let valid = providerPackBuildInputsSchema.safeParse(candidate).success;
        try {
          assertPublicPackCatalogBytes(candidate);
          valid &&= packCatalogCanonicalByteCount(candidate) <= packPublicationLimits.maximumInputBytes;
        } catch (error) { if (!(error instanceof TypeError)) throw error; valid = false; }
        if (!valid) {
          outcomes.push(await this.#requests.rejectInTransaction(tx, { publicRepackId, sourceRevisionIdentity, boundaryIdentity }));
          continue;
        }
        const inputBytes = packCatalogCanonicalByteCount(candidate);
        if (outcomes.length > 0 && capturedBytes + inputBytes > packPublicationLimits.maximumInputBytes) {
          complete = false;
          break;
        }
        capturedBytes += inputBytes;
        for (const dependency of delivery?.sharedDependencies ?? []) {
          packInvariant(candidate.expectedDependencies.some(item => item.kind === dependency.kind &&
            item.identity === dependency.identity && item.contentSha256 === dependency.contentSha256), "PACK_INPUT_INVALID");
        }
        const head = await tx.pack_publication_heads.findUnique({ where: { public_repack_id: publicRepackId } });
        const previousArtifact = head?.active_snapshot_id ? await tx.pack_snapshot_artifacts.findUnique({ where: { public_pack_snapshot_id: head.active_snapshot_id } }) : null;
        const result = await this.capture.evaluate({ candidate, evaluatedAt,
          previousSnapshot: previousArtifact?.snapshot_json as unknown as import("@packscout/contracts").PublicPackSnapshot | null });
        outcomes.push(await this.#requests.enqueueInTransaction(tx, { ...result, boundaryIdentity }));
      }
      const acknowledgmentDigest = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { previousDigest: progress.result_sha256, outcomes });
      await tx.pack_publication_change_receipts.create({ data: { ...this.context.where,
        boundary_identity: `page:${boundarySha256}:${progress.page_number}`,
        boundary_sha256: boundarySha256, result_sha256: acknowledgmentDigest, outcomes_json: outcomes as unknown as Prisma.InputJsonValue } });
      await tx.pack_publication_impact_progress.update({ where: { organization_id_provider_id_boundary_identity: {
        ...this.context.where, boundary_identity: boundaryIdentity } }, data: { after_pack_id: outcomes.at(-1)?.publicRepackId ?? progress.after_pack_id,
        page_number: { increment: 1 }, result_sha256: acknowledgmentDigest, complete } });
      if (!delivery && complete) await tx.pack_publication_scopes.update({ where: { provider_id: this.context.scope.providerId },
        data: { change_sequence: progress.through_sequence! } });
      if (delivery && complete) await tx.pack_publication_scopes.update({ where: { provider_id: this.context.scope.providerId },
        data: { shared_change_sequence: progress.shared_sequence! } });
      return { boundaryIdentity, complete, acknowledgmentDigest: complete ? acknowledgmentDigest : null, outcomes };
    });
  }
  private async affected(tx: ProviderTransactionClient, references: Array<{ kind: string; id: string }>, after: string | null): Promise<string[]> {
    const ids = (kind: string) => references.filter(row => row.kind === kind).map(row => packCatalogUuidSchema.parse(row.id));
    const packs = ids("pack"), contents = ids("pack_content"), snapshots = ids("pack_content_snapshot"),
      collectibles = ids("collectible"), aliases = ids("collectible_name_alias"), categories = ids("category");
    const allPacks = references.some(row => row.kind === "ev_policy");
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM (
      SELECT id FROM packs WHERE ${allPacks} OR id = ANY(${packs}::uuid[]) OR category_id = ANY(${categories}::uuid[])
      UNION SELECT pack_id AS id FROM pack_contents WHERE id = ANY(${contents}::uuid[])
      UNION SELECT pack_id AS id FROM pack_content_snapshots WHERE id = ANY(${snapshots}::uuid[])
      UNION SELECT c.pack_id AS id FROM pack_contents c JOIN collectibles a ON a.id = c.collectible_id
        WHERE c.lifecycle = 'active' AND (c.collectible_id = ANY(${collectibles}::uuid[]) OR a.category_id = ANY(${categories}::uuid[]))
      UNION SELECT c.pack_id AS id FROM pack_contents c JOIN collectible_name_aliases a ON a.collectible_id = c.collectible_id
        WHERE c.lifecycle = 'active' AND a.id = ANY(${aliases}::uuid[])
      ) affected WHERE (${after}::uuid IS NULL OR id > ${after}::uuid) ORDER BY id LIMIT ${packPublicationLimits.affectedPacks + 1}`);
    return rows.map(row => row.id);
  }
}
