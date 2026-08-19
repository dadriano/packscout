import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  productionReceiptSchema,
  type ProductionDataReleasePath,
  type ProductionReceipt,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import {
  loadPromotionBootstrapState,
  verifyPromotionBootstrap,
} from "./catalog-promotion-bootstrap-repository.ts";
import {
  PromotionLedgerError,
  activeStates,
  catalogPreparedMatches,
  failureCodePattern,
  mapPromotionOperation as mapOperation,
  maximumOperationCount,
  maximumManifestSourceProofBytes,
  maximumReceiptBytes,
  maximumRequestBytes,
  operationIdPattern,
  operationKindPattern,
  pathByKind,
  promotionUuid as uuid,
  requestPathPattern,
  requireBoundRepositoryKey,
  requireCatalogPrepared,
  requireClaimWindow,
  requireJsonText,
  sha256,
  sha256Pattern,
  workerKeyPattern,
  type CatalogPromotionClaim,
  type CatalogPromotionHealth,
  type CatalogPromotionOperation,
  type CatalogPromotionPreparedSummary,
  type CatalogPromotionScope,
  type CatalogReleaseBaseline,
  type PromotionAttemptClaim,
  type PromotionAttemptRow as AttemptRow,
  type PromotionAttemptState,
  type PromotionBootstrapState,
  type PromotionFailureClass,
  type PromotionHealthSnapshot,
  type PromotionLaneRow as LaneRow,
  type PromotionOperationInput,
  type PromotionOperationRecord,
  type PromotionOperationRow as OperationRow,
  type PromotionTerminalState,
} from "./catalog-promotion-ledger.ts";

export * from "./catalog-promotion-ledger.ts";

export class PrismaCatalogPromotionRepository {
  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly binding: Readonly<{
      organizationId: string;
      deploymentKey: string;
    }>,
  ) {
    requireBoundRepositoryKey(binding.deploymentKey);
  }

  loadBootstrapState(laneKey: string): Promise<PromotionBootstrapState> {
    return loadPromotionBootstrapState(this.database, this.binding, laneKey);
  }

  async coalesce(input: CatalogPromotionScope & {
    settledWatermark: bigint;
    requestedAt: Date;
  }): Promise<"created" | "coalesced" | "already_covered"> {
    this.requireScope(input);
    const previous = await this.loadHealthSnapshot({
      laneKey: input.lane,
      now: input.requestedAt,
    });
    await this.coalesceSettledWatermark({
      laneKey: input.lane,
      settledWatermark: input.settledWatermark,
      settledAt: input.requestedAt,
      delayedVendorCount: 0,
    });
    if (previous === null) return "created";
    return input.settledWatermark <= previous.requestedWatermark
      ? "already_covered" : "coalesced";
  }

  async claim(input: CatalogPromotionScope & {
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<CatalogPromotionClaim | null> {
    this.requireScope(input);
    const claimed = await this.claimAttempt({
      laneKey: input.lane,
      claimOwner: input.workerId,
      now: input.now,
      claimExpiresAt: input.leaseExpiresAt,
    });
    if (claimed === null) return null;
    return this.loadCatalogClaim(claimed.attemptId, claimed.claimToken);
  }

  async loadBaseline(scope: CatalogPromotionScope): Promise<CatalogReleaseBaseline | null> {
    this.requireScope(scope);
    const lanes = await this.database.$queryRaw<Array<{
      bootstrapState: PromotionHealthSnapshot["bootstrapState"];
      confirmedWatermark: bigint;
      confirmedPublicationIdentity: string | null;
    }>>(Prisma.sql`
      select bootstrap_state as "bootstrapState",
             confirmed_watermark as "confirmedWatermark",
             confirmed_publication_identity as "confirmedPublicationIdentity"
      from public.promotion_lanes
      where organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
        and lane_key = ${scope.lane}
    `);
    const lane = lanes[0];
    if (!lane || lane.bootstrapState === "unverified") {
      throw new PromotionLedgerError("PROMOTION_BOOTSTRAP_UNVERIFIED");
    }
    if (
      lane.bootstrapState === "verified_empty"
      || lane.confirmedPublicationIdentity === null
    ) return null;
    const rows = await this.database.$queryRaw<AttemptRow[]>(Prisma.sql`
      select id, lane_key as "laneKey", target_watermark as "targetWatermark", state,
             content_identity as "contentIdentity",
             publication_identity as "publicationIdentity",
             expected_predecessor_identity as "expectedPredecessorIdentity",
             prepared_classification as "preparedClassification",
             observation_sequence as "observationSequence",
             public_config_hash as "publicConfigHash",
             repack_search_index_hash as "repackSearchIndexHash",
             public_vendor_keys as "publicVendorKeys", prepared_at as "preparedAt",
             manifest_source_proof_body as "manifestSourceProofBody",
             manifest_source_proof_sha256 as "manifestSourceProofSha256",
             claim_token as "claimToken", claim_expires_at as "claimExpiresAt",
             last_heartbeat_at as "lastHeartbeatAt",
             claim_count as "claimCount", retry_count as "retryCount",
             retry_at as "retryAt", delayed_vendor_count as "delayedVendorCount",
             created_at as "createdAt"
      from public.promotion_attempts
      where organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
        and lane_key = ${scope.lane}
        and state in ('published', 'unchanged')
        and target_watermark <= ${lane.confirmedWatermark}
        and publication_identity = ${lane.confirmedPublicationIdentity}
        and prepared_classification is not null
      order by target_watermark desc, terminal_at desc
      limit 1
    `);
    const prepared = rows[0] ? this.preparedFromAttempt(rows[0]) : null;
    if (prepared === null) {
      throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
    }
    return {
      activePublicReleaseId: prepared.publicReleaseId,
      observationSequence: prepared.observationSequence,
      contentHash: prepared.contentHash,
      publicConfigHash: prepared.publicConfigHash,
      repackSearchIndexHash: prepared.repackSearchIndexHash,
      publicVendorKeys: prepared.publicVendorKeys,
    };
  }

  async persistPreparedOperations(input: {
    attemptId: string;
    claimToken: string;
    prepared: CatalogPromotionPreparedSummary;
    operations: readonly CatalogPromotionOperation[];
    preparedAt: Date;
  }): Promise<boolean> {
    requireCatalogPrepared(input.prepared);
    if (
      input.operations.length === 0
      || input.operations.some((operation, ordinal) =>
        operation.ordinal !== ordinal
        || operation.publicationId !== input.prepared.publicReleaseId
        || operation.path !== pathByKind[operation.kind]
        || operation.bodyDigest !== sha256(operation.bodyJson)
        || operation.dispatchCount !== 0
        || operation.lastDispatchedAt !== null
        || operation.acknowledgedAt !== null
        || operation.receipt !== null)
    ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    const persisted = await this.persistAssembledOperations({
      attemptId: input.attemptId,
      claimToken: input.claimToken,
      now: input.preparedAt,
      contentIdentity: input.prepared.contentHash,
      publicationIdentity: input.prepared.publicReleaseId,
      catalogPrepared: input.prepared,
      operations: input.operations.map((operation) => ({
        operationIndex: operation.ordinal,
        operationId: operation.operationId,
        operationKind: operation.kind,
        requestPath: operation.path,
        canonicalRequestBody: operation.bodyJson,
      })),
    });
    return persisted !== null;
  }

  async markOperationDispatched(input: {
    attemptId: string;
    claimToken: string;
    ordinal: number;
    dispatchedAt: Date;
  }): Promise<boolean> {
    const operationId = await this.operationIdAtOrdinal(
      input.attemptId,
      input.ordinal,
    );
    if (operationId === null) return false;
    return this.markOperationSent({
      attemptId: input.attemptId,
      operationId,
      claimToken: input.claimToken,
      sentAt: input.dispatchedAt,
    });
  }

  async acknowledgeTerminal(input: {
    attemptId: string;
    claimToken: string;
    outcome: PromotionTerminalState;
    failureCode: string | null;
    receipt: ProductionReceipt | null;
    completedAt: Date;
    prepared: CatalogPromotionPreparedSummary | null;
  }): Promise<boolean> {
    if (input.prepared !== null) requireCatalogPrepared(input.prepared);
    const attempt = await this.loadBoundAttempt(input.attemptId);
    if (attempt === null) return false;
    if (
      (input.prepared === null) !== (attempt.preparedClassification === null)
      || (input.prepared !== null && !catalogPreparedMatches(attempt, input.prepared))
    ) throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
    if (input.receipt !== null) productionReceiptSchema.parse(input.receipt);
    return this.completeAttempt({
      attemptId: input.attemptId,
      claimToken: input.claimToken,
      terminalState: input.outcome,
      completedAt: input.completedAt,
      receiptBody: input.receipt === null ? null : canonicalJson(input.receipt),
      failureClass: input.outcome === "failed" ? "deterministic" : null,
      failureCode: input.failureCode,
    });
  }

  async loadHealth(scope: CatalogPromotionScope): Promise<CatalogPromotionHealth> {
    this.requireScope(scope);
    const health = await this.loadHealthSnapshot({ laneKey: scope.lane, now: new Date() });
    if (health === null) {
      return {
        settledWatermark: 0n,
        requestedWatermark: null,
        activeAttempt: null,
        lastActivatedWatermark: null,
        lastActivatedAt: null,
        lastUnchangedWatermark: null,
        lastUnchangedAt: null,
        retryAt: null,
        delayedVendorCount: null,
      };
    }
    const active = health.activeAttemptId === null
      || health.activeAttemptWatermark === null
      || health.activeAttemptStartedAt === null
      ? null : await this.loadActiveHealthAttempt(health.activeAttemptId);
    return {
      settledWatermark: health.settledWatermark,
      requestedWatermark: health.requestedWatermark === 0n
        ? null : health.requestedWatermark,
      activeAttempt: active,
      lastActivatedWatermark: health.lastActivatedWatermark === 0n
        ? null : health.lastActivatedWatermark,
      lastActivatedAt: health.lastActivatedAt,
      lastUnchangedWatermark: health.lastUnchangedWatermark,
      lastUnchangedAt: health.lastUnchangedObservedAt,
      retryAt: health.retryAt,
      delayedVendorCount: health.delayedVendorCount,
    };
  }

  async coalesceSettledWatermark(input: {
    laneKey: string;
    settledWatermark: bigint;
    settledAt: Date;
    delayedVendorCount: number;
  }): Promise<Readonly<{
    settledWatermark: bigint;
    requestedWatermark: bigint;
  }>> {
    this.requireLaneInput(input.laneKey);
    if (
      input.settledWatermark < 0n
      || !Number.isInteger(input.delayedVendorCount)
      || input.delayedVendorCount < 0
      || input.delayedVendorCount > 100_000
      || !Number.isFinite(input.settledAt.getTime())
    ) {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    const rows = await this.database.$queryRaw<Array<{
      settledWatermark: bigint;
      requestedWatermark: bigint;
    }>>(Prisma.sql`
      insert into public.promotion_lanes (
        organization_id, deployment_key, lane_key,
        settled_watermark, settled_at, requested_watermark, requested_at,
        delayed_vendor_count, created_at, updated_at
      ) values (
        ${uuid(this.binding.organizationId)}, ${this.binding.deploymentKey},
        ${input.laneKey}, ${input.settledWatermark}, ${input.settledAt},
        ${input.settledWatermark}, ${input.settledAt},
        ${input.delayedVendorCount}, ${input.settledAt}, ${input.settledAt}
      )
      on conflict (organization_id, deployment_key, lane_key) do update
      set settled_watermark = greatest(
            promotion_lanes.settled_watermark,
            excluded.settled_watermark
          ),
          settled_at = case
            when excluded.settled_watermark > promotion_lanes.settled_watermark
              then excluded.settled_at
            else promotion_lanes.settled_at
          end,
          requested_watermark = greatest(
            promotion_lanes.requested_watermark,
            excluded.requested_watermark
          ),
          requested_at = case
            when excluded.requested_watermark > promotion_lanes.requested_watermark
              then excluded.requested_at
            else promotion_lanes.requested_at
          end,
          delayed_vendor_count = case
            when excluded.requested_watermark > promotion_lanes.requested_watermark
              then excluded.delayed_vendor_count
            else promotion_lanes.delayed_vendor_count
          end,
          updated_at = greatest(promotion_lanes.updated_at, excluded.updated_at)
      returning settled_watermark as "settledWatermark",
                requested_watermark as "requestedWatermark"
    `);
    return rows[0]!;
  }

  async verifyBootstrap(input: {
    laneKey: string;
    observedPublicationIdentity: string | null;
    observedWatermark: bigint;
    observedReceiptSha256: string | null;
    verifiedAt: Date;
  }): Promise<void> {
    return verifyPromotionBootstrap(this.database, this.binding, input);
  }

  async claimAttempt(input: {
    laneKey: string;
    claimOwner: string;
    now: Date;
    claimExpiresAt: Date;
  }): Promise<PromotionAttemptClaim | null> {
    this.requireLaneInput(input.laneKey);
    if (!workerKeyPattern.test(input.claimOwner)) {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    requireClaimWindow(input.now, input.claimExpiresAt);
    return this.database.$transaction(async (transaction) => {
      const lane = await this.lockLane(transaction, input.laneKey);
      if (!lane || lane.bootstrapState === "unverified") {
        throw new PromotionLedgerError("PROMOTION_BOOTSTRAP_UNVERIFIED");
      }
      const active = await this.lockActiveAttempt(transaction, input.laneKey);
      const claimToken = randomUUID();
      if (active) {
        if (
          (active.claimExpiresAt !== null && active.claimExpiresAt > input.now)
          || (active.state === "retry_wait"
            && active.retryAt !== null && active.retryAt > input.now)
        ) return null;
        const resumedState: PromotionAttemptState = active.contentIdentity === null
          ? "assembling"
          : active.state === "in_progress" ? "in_progress" : "ready";
        const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
          update public.promotion_attempts
          set state = ${resumedState}, claim_owner = ${input.claimOwner},
              claim_token = ${uuid(claimToken)},
              claim_expires_at = ${input.claimExpiresAt},
              last_heartbeat_at = ${input.now}, claim_count = claim_count + 1,
              retry_at = null, updated_at = ${input.now}
          where id = ${uuid(active.id)}
          returning id, target_watermark as "targetWatermark", state,
                    content_identity as "contentIdentity",
                    publication_identity as "publicationIdentity",
                    expected_predecessor_identity as "expectedPredecessorIdentity",
                    prepared_classification as "preparedClassification",
                    observation_sequence as "observationSequence",
                    public_config_hash as "publicConfigHash",
                    repack_search_index_hash as "repackSearchIndexHash",
                    public_vendor_keys as "publicVendorKeys", prepared_at as "preparedAt",
                    manifest_source_proof_body as "manifestSourceProofBody",
                    manifest_source_proof_sha256 as "manifestSourceProofSha256",
                    lane_key as "laneKey", claim_token as "claimToken",
                    claim_expires_at as "claimExpiresAt",
                    last_heartbeat_at as "lastHeartbeatAt",
                    claim_count as "claimCount", retry_count as "retryCount",
                    retry_at as "retryAt", delayed_vendor_count as "delayedVendorCount",
                    created_at as "createdAt"
        `);
        return this.toClaim(rows[0]!, true);
      }
      const latest = await transaction.$queryRaw<Array<{ watermark: bigint | null }>>(Prisma.sql`
        select max(target_watermark) as watermark
        from public.promotion_attempts
        where organization_id = ${uuid(this.binding.organizationId)}
          and deployment_key = ${this.binding.deploymentKey}
          and lane_key = ${input.laneKey}
      `);
      const latestAttempt = latest[0]?.watermark ?? 0n;
      if (
        lane.requestedWatermark <= lane.confirmedWatermark
        || lane.requestedWatermark <= latestAttempt
      ) return null;
      const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
        insert into public.promotion_attempts (
          organization_id, deployment_key, lane_key, target_watermark,
          expected_predecessor_identity, claim_owner, claim_token,
          claim_expires_at, last_heartbeat_at, claim_count,
          delayed_vendor_count, created_at, updated_at
        ) values (
          ${uuid(this.binding.organizationId)}, ${this.binding.deploymentKey},
          ${input.laneKey}, ${lane.requestedWatermark},
          ${lane.confirmedPublicationIdentity}, ${input.claimOwner},
          ${uuid(claimToken)}, ${input.claimExpiresAt}, ${input.now}, 1,
          ${lane.delayedVendorCount}, ${input.now}, ${input.now}
        )
        returning id, target_watermark as "targetWatermark", state,
                  content_identity as "contentIdentity",
                  publication_identity as "publicationIdentity",
                  expected_predecessor_identity as "expectedPredecessorIdentity",
                  prepared_classification as "preparedClassification",
                  observation_sequence as "observationSequence",
                  public_config_hash as "publicConfigHash",
                  repack_search_index_hash as "repackSearchIndexHash",
                  public_vendor_keys as "publicVendorKeys", prepared_at as "preparedAt",
                  manifest_source_proof_body as "manifestSourceProofBody",
                  manifest_source_proof_sha256 as "manifestSourceProofSha256",
                  lane_key as "laneKey", claim_token as "claimToken",
                  claim_expires_at as "claimExpiresAt",
                  last_heartbeat_at as "lastHeartbeatAt",
                  claim_count as "claimCount", retry_count as "retryCount",
                  retry_at as "retryAt", delayed_vendor_count as "delayedVendorCount",
                  created_at as "createdAt"
      `);
      return this.toClaim(rows[0]!, false);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async heartbeat(input: {
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    claimExpiresAt: Date;
  }): Promise<boolean>;
  async heartbeat(input: {
    attemptId: string;
    claimToken: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  async heartbeat(input: {
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    claimExpiresAt: Date;
  } | {
    attemptId: string;
    claimToken: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean> {
    const heartbeatAt = "heartbeatAt" in input ? input.heartbeatAt : input.now;
    const claimExpiresAt = "claimExpiresAt" in input
      ? input.claimExpiresAt : input.leaseExpiresAt;
    requireClaimWindow(heartbeatAt, claimExpiresAt);
    const updated = await this.database.$executeRaw(Prisma.sql`
      update public.promotion_attempts
      set last_heartbeat_at = ${heartbeatAt},
          claim_expires_at = ${claimExpiresAt}, updated_at = ${heartbeatAt}
      where id = ${uuid(input.attemptId)}
        and organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
        and claim_token = ${uuid(input.claimToken)}
        and claim_expires_at > ${heartbeatAt}
        and state in ('assembling', 'ready', 'in_progress')
    `);
    return updated === 1;
  }

  async persistAssembledOperations(input: {
    attemptId: string;
    claimToken: string;
    now: Date;
    contentIdentity: string;
    publicationIdentity: string | null;
    operations: readonly PromotionOperationInput[];
    catalogPrepared?: CatalogPromotionPreparedSummary;
    preparedClassification?: CatalogPromotionPreparedSummary["classification"];
    manifestSourceProof?: Readonly<{
      canonicalBody: string;
      sha256: string;
    }>;
  }): Promise<readonly PromotionOperationRecord[] | null> {
    if (!sha256Pattern.test(input.contentIdentity)) {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    if (input.catalogPrepared !== undefined) {
      requireCatalogPrepared(input.catalogPrepared);
      if (
        input.catalogPrepared.contentHash !== input.contentIdentity
        || input.catalogPrepared.publicReleaseId !== input.publicationIdentity
      ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    if (
      input.catalogPrepared !== undefined &&
      input.preparedClassification !== undefined &&
      input.catalogPrepared.classification !== input.preparedClassification
    ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    if (input.manifestSourceProof !== undefined) {
      requireJsonText(
        input.manifestSourceProof.canonicalBody,
        maximumManifestSourceProofBytes,
      );
      if (
        !sha256Pattern.test(input.manifestSourceProof.sha256) ||
        sha256(input.manifestSourceProof.canonicalBody) !==
          input.manifestSourceProof.sha256
      ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    this.requireOperations(input.operations);
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.lockClaimedAttempt(transaction, input, input.now);
      if (!attempt) return null;
      if (
        (attempt.contentIdentity !== null
          && attempt.contentIdentity !== input.contentIdentity)
        || (attempt.publicationIdentity !== null
          && attempt.publicationIdentity !== input.publicationIdentity)
        || (input.preparedClassification !== undefined &&
          attempt.preparedClassification !== null &&
          attempt.preparedClassification !== input.preparedClassification)
        || (input.manifestSourceProof !== undefined &&
          attempt.laneKey !== "heat")
        || (attempt.laneKey === "heat" &&
          input.manifestSourceProof === undefined)
        || (attempt.manifestSourceProofBody !== null && (
          input.manifestSourceProof === undefined ||
          attempt.manifestSourceProofBody !==
            input.manifestSourceProof.canonicalBody ||
          attempt.manifestSourceProofSha256 !== input.manifestSourceProof.sha256
        ))
        || (input.catalogPrepared !== undefined && (
          attempt.targetWatermark !== input.catalogPrepared.requestedWatermark
          || attempt.expectedPredecessorIdentity !==
            input.catalogPrepared.expectedPredecessorPublicReleaseId
          || (attempt.preparedClassification !== null &&
            !catalogPreparedMatches(attempt, input.catalogPrepared))
        ))
      ) {
        throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
      }
      const existing = await this.loadOperations(transaction, attempt.id);
      const expected = input.operations.map((operation) => ({
        ...operation,
        requestSha256: sha256(operation.canonicalRequestBody),
      }));
      if (existing.length > 0) {
        if (
          existing.length !== expected.length
          || existing.some((operation, index) => {
            const candidate = expected[index]!;
            return operation.operationIndex !== candidate.operationIndex
              || operation.operationId !== candidate.operationId
              || operation.operationKind !== candidate.operationKind
              || operation.requestPath !== candidate.requestPath
              || operation.canonicalRequestBody !== candidate.canonicalRequestBody
              || operation.requestSha256 !== candidate.requestSha256;
          })
        ) {
          throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
        }
      } else {
        const values = expected.map((operation) => Prisma.sql`(
          ${uuid(attempt.id)}, ${uuid(this.binding.organizationId)},
          ${this.binding.deploymentKey}, ${attempt.laneKey},
          ${operation.operationIndex}, ${operation.operationId},
          ${operation.operationKind}, ${operation.requestPath},
          ${operation.canonicalRequestBody}, ${operation.requestSha256},
          ${input.now}, ${input.now}
        )`);
        await transaction.$executeRaw(Prisma.sql`
          insert into public.promotion_operations (
            attempt_id, organization_id, deployment_key, lane_key,
            operation_index, operation_id, operation_kind, request_path,
            canonical_request_body, request_sha256, created_at, updated_at
          ) values ${Prisma.join(values)}
        `);
      }
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_attempts
        set content_identity = ${input.contentIdentity},
            publication_identity = ${input.publicationIdentity},
            prepared_classification = ${input.catalogPrepared?.classification
              ?? input.preparedClassification
              ?? attempt.preparedClassification},
            observation_sequence = ${input.catalogPrepared?.observationSequence
              ?? attempt.observationSequence},
            public_config_hash = ${input.catalogPrepared?.publicConfigHash
              ?? attempt.publicConfigHash},
            repack_search_index_hash = ${input.catalogPrepared?.repackSearchIndexHash
              ?? attempt.repackSearchIndexHash},
            public_vendor_keys = ${input.catalogPrepared?.publicVendorKeys
              ?? attempt.publicVendorKeys},
            manifest_source_proof_body = ${input.manifestSourceProof
              ?.canonicalBody ?? attempt.manifestSourceProofBody},
            manifest_source_proof_sha256 = ${input.manifestSourceProof
              ?.sha256 ?? attempt.manifestSourceProofSha256},
            prepared_at = ${input.catalogPrepared === undefined &&
                input.preparedClassification === undefined
              ? attempt.preparedAt : input.now},
            delayed_vendor_count = ${input.catalogPrepared?.delayedVendorCount
              ?? 0},
            state = 'ready', updated_at = ${input.now}
        where id = ${uuid(attempt.id)}
      `);
      if (input.catalogPrepared !== undefined) {
        await transaction.$executeRaw(Prisma.sql`
          update public.promotion_lanes
          set delayed_vendor_count = ${input.catalogPrepared.delayedVendorCount},
              updated_at = ${input.now}
          where organization_id = ${uuid(this.binding.organizationId)}
            and deployment_key = ${this.binding.deploymentKey}
            and lane_key = ${attempt.laneKey}
            and requested_watermark = ${attempt.targetWatermark}
        `);
      }
      return (await this.loadOperations(transaction, attempt.id)).map(mapOperation);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async firstUnacknowledgedOperation(input: {
    attemptId: string;
    claimToken: string;
    now: Date;
  }): Promise<PromotionOperationRecord | null> {
    const rows = await this.database.$queryRaw<OperationRow[]>(Prisma.sql`
      select operation.id, operation.operation_index as "operationIndex",
             operation.operation_id as "operationId",
             operation.operation_kind as "operationKind",
             operation.request_path as "requestPath",
             operation.canonical_request_body as "canonicalRequestBody",
             operation.request_sha256 as "requestSha256", operation.state,
             operation.send_count as "sendCount", operation.last_sent_at as "lastSentAt",
             operation.acknowledged_at as "acknowledgedAt",
             operation.receipt_body as "receiptBody",
             operation.receipt_sha256 as "receiptSha256"
      from public.promotion_operations operation
      join public.promotion_attempts attempt on attempt.id = operation.attempt_id
      where attempt.id = ${uuid(input.attemptId)}
        and attempt.organization_id = ${uuid(this.binding.organizationId)}
        and attempt.deployment_key = ${this.binding.deploymentKey}
        and attempt.claim_token = ${uuid(input.claimToken)}
        and attempt.claim_expires_at > ${input.now}
        and operation.state <> 'acknowledged'
      order by operation.operation_index
      limit 1
    `);
    return rows[0] ? mapOperation(rows[0]) : null;
  }

  async listAttemptOperations(input: {
    attemptId: string;
  }): Promise<readonly PromotionOperationRecord[]> {
    const attempt = await this.loadBoundAttempt(input.attemptId);
    if (attempt === null) return [];
    return (await this.loadOperations(this.database, attempt.id)).map(mapOperation);
  }

  async markOperationSent(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
    sentAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.lockClaimedAttempt(transaction, input, input.sentAt);
      if (!attempt) return false;
      const operation = await this.lockOperation(transaction, attempt.id, input.operationId);
      if (!operation) throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
      if (operation.state === "acknowledged") return true;
      await this.assertFirstUnacknowledged(transaction, attempt.id, operation.operationIndex);
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_operations
        set state = 'sent', send_count = send_count + 1,
            last_sent_at = ${input.sentAt}, updated_at = ${input.sentAt}
        where id = ${uuid(operation.id)}
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_attempts
        set state = 'in_progress', updated_at = ${input.sentAt}
        where id = ${uuid(attempt.id)}
      `);
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async acknowledgeOperation(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
    acknowledgedAt: Date;
    receiptBody: string;
  }): Promise<boolean>;
  async acknowledgeOperation(input: {
    attemptId: string;
    claimToken: string;
    ordinal: number;
    receipt: ProductionReceipt;
    acknowledgedAt: Date;
  }): Promise<boolean>;
  async acknowledgeOperation(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
    acknowledgedAt: Date;
    receiptBody: string;
  } | {
    attemptId: string;
    claimToken: string;
    ordinal: number;
    receipt: ProductionReceipt;
    acknowledgedAt: Date;
  }): Promise<boolean> {
    let operationId: string;
    let receiptBody: string;
    if ("ordinal" in input) {
      const receipt = productionReceiptSchema.parse(input.receipt);
      const operation = await this.loadBoundOperationAtOrdinal(
        input.attemptId,
        input.ordinal,
      );
      if (operation === null) return false;
      if (
        receipt.operationId !== operation.operationId
        || receipt.requestDigest !== operation.requestSha256
      ) throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
      operationId = operation.operationId;
      receiptBody = canonicalJson(receipt);
    } else {
      operationId = input.operationId;
      receiptBody = input.receiptBody;
    }
    requireJsonText(receiptBody, maximumReceiptBytes);
    const receiptSha256 = sha256(receiptBody);
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.lockClaimedAttempt(
        transaction,
        input,
        input.acknowledgedAt,
      );
      if (!attempt) return false;
      const operation = await this.lockOperation(transaction, attempt.id, operationId);
      if (!operation) throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
      if (operation.state === "acknowledged") {
        if (
          operation.receiptBody !== receiptBody
          || operation.receiptSha256 !== receiptSha256
        ) throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
        return true;
      }
      if (operation.state !== "sent") {
        throw new PromotionLedgerError("PROMOTION_OPERATION_ORDER_INVALID");
      }
      await this.assertFirstUnacknowledged(transaction, attempt.id, operation.operationIndex);
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_operations
        set state = 'acknowledged', acknowledged_at = ${input.acknowledgedAt},
            receipt_body = ${receiptBody}, receipt_sha256 = ${receiptSha256},
            updated_at = ${input.acknowledgedAt}
        where id = ${uuid(operation.id)}
      `);
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async scheduleRetry(input: {
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: "technical" | "reconciliation";
    failureCode: string;
  }): Promise<boolean>;
  async scheduleRetry(input: {
    attemptId: string;
    claimToken: string;
    failureCode: string;
    retryCount: number;
    retryAt: Date;
    acknowledgedAt: Date;
  }): Promise<boolean>;
  async scheduleRetry(input: {
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: "technical" | "reconciliation";
    failureCode: string;
  } | {
    attemptId: string;
    claimToken: string;
    failureCode: string;
    retryCount: number;
    retryAt: Date;
    acknowledgedAt: Date;
  }): Promise<boolean> {
    const failedAt = "failedAt" in input ? input.failedAt : input.acknowledgedAt;
    const failureClass = "failureClass" in input ? input.failureClass : "technical";
    if (
      input.retryAt <= failedAt
      || !failureCodePattern.test(input.failureCode)
    ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.lockClaimedAttempt(transaction, input, failedAt);
      if (!attempt) return false;
      const retryCount = "retryCount" in input
        ? input.retryCount : attempt.retryCount + 1;
      if (
        !Number.isSafeInteger(retryCount)
        || retryCount !== attempt.retryCount + 1
        || retryCount > 1_000
      ) throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_attempts
        set state = 'retry_wait', retry_at = ${input.retryAt},
            retry_count = ${retryCount},
            failure_class = ${failureClass}, failure_code = ${input.failureCode},
            claim_owner = null, claim_token = null, claim_expires_at = null,
            last_heartbeat_at = null, updated_at = ${failedAt}
        where id = ${uuid(attempt.id)}
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_lanes
        set next_retry_at = ${input.retryAt}, updated_at = ${failedAt}
        where organization_id = ${uuid(this.binding.organizationId)}
          and deployment_key = ${this.binding.deploymentKey}
          and lane_key = (
            select lane_key from public.promotion_attempts where id = ${uuid(attempt.id)}
          )
      `);
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async completeAttempt(input: {
    attemptId: string;
    claimToken: string;
    terminalState: PromotionTerminalState;
    completedAt: Date;
    receiptBody: string | null;
    failureClass: PromotionFailureClass | null;
    failureCode: string | null;
  }): Promise<boolean> {
    const successful = input.terminalState !== "failed";
    if (
      (successful && input.receiptBody === null)
      || ((input.failureClass === null) !== (input.failureCode === null))
      || (input.terminalState === "failed" && input.failureClass === null)
      || (input.terminalState !== "failed" && input.failureClass !== null)
      || (input.failureCode !== null && !failureCodePattern.test(input.failureCode))
    ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    if (input.receiptBody !== null) {
      requireJsonText(input.receiptBody, maximumReceiptBytes);
    }
    const receiptSha256 = input.receiptBody === null ? null : sha256(input.receiptBody);
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.lockClaimedAttempt(transaction, input, input.completedAt);
      if (!attempt) return false;
      const lane = await this.lockLaneByAttempt(transaction, attempt.id);
      if (!lane) throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
      if (
        input.terminalState !== "failed"
        && input.terminalState !== "rolled_back"
        && attempt.targetWatermark < lane.confirmedWatermark
      ) throw new PromotionLedgerError("PROMOTION_WATERMARK_REGRESSED");
      if (successful) {
        const remaining = await transaction.$queryRaw<Array<{
          total: bigint;
          unacknowledged: bigint;
        }>>(Prisma.sql`
          select count(*) as total,
                 count(*) filter (where state <> 'acknowledged') as unacknowledged
          from public.promotion_operations
          where attempt_id = ${uuid(attempt.id)}
        `);
        if (
          attempt.contentIdentity === null
          || (remaining[0]?.total ?? 0n) === 0n
          || (remaining[0]?.unacknowledged ?? 1n) !== 0n
        ) {
          throw new PromotionLedgerError("PROMOTION_OPERATION_ORDER_INVALID");
        }
      }
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_attempts
        set state = ${input.terminalState}, retry_at = null,
            failure_class = ${input.failureClass}, failure_code = ${input.failureCode},
            terminal_receipt_body = ${input.receiptBody},
            terminal_receipt_sha256 = ${receiptSha256},
            terminal_at = ${input.completedAt}, claim_owner = null,
            claim_token = null, claim_expires_at = null,
            last_heartbeat_at = null, updated_at = ${input.completedAt}
        where id = ${uuid(attempt.id)}
      `);
      if (input.terminalState === "published") {
        if (attempt.publicationIdentity === null) {
          throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
        }
        await transaction.$executeRaw(Prisma.sql`
          update public.promotion_lanes
          set bootstrap_state = 'verified_local',
              bootstrap_verified_at = coalesce(bootstrap_verified_at, ${input.completedAt}),
              confirmed_watermark = ${attempt.targetWatermark},
              confirmed_publication_identity = ${attempt.publicationIdentity},
              confirmed_receipt_sha256 = ${receiptSha256},
              last_activated_watermark = ${attempt.targetWatermark},
              last_activated_at = ${input.completedAt}, next_retry_at = null,
              updated_at = ${input.completedAt}
          where organization_id = ${uuid(this.binding.organizationId)}
            and deployment_key = ${this.binding.deploymentKey}
            and lane_key = ${lane.laneKey}
        `);
      } else if (input.terminalState === "unchanged") {
        await transaction.$executeRaw(Prisma.sql`
          update public.promotion_lanes
          set confirmed_watermark = ${attempt.targetWatermark},
              confirmed_receipt_sha256 = ${receiptSha256},
              last_unchanged_watermark = ${attempt.targetWatermark},
              last_unchanged_observed_at = ${input.completedAt},
              next_retry_at = null,
              updated_at = ${input.completedAt}
          where organization_id = ${uuid(this.binding.organizationId)}
            and deployment_key = ${this.binding.deploymentKey}
            and lane_key = ${lane.laneKey}
        `);
      } else {
        await transaction.$executeRaw(Prisma.sql`
          update public.promotion_lanes
          set next_retry_at = null, updated_at = ${input.completedAt}
          where organization_id = ${uuid(this.binding.organizationId)}
            and deployment_key = ${this.binding.deploymentKey}
            and lane_key = ${lane.laneKey}
        `);
      }
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadHealthSnapshot(input: {
    laneKey: string;
    now: Date;
  }): Promise<PromotionHealthSnapshot | null> {
    this.requireLaneInput(input.laneKey);
    const rows = await this.database.$queryRaw<Array<LaneRow & {
      activeAttemptId: string | null;
      activeAttemptState: PromotionAttemptState | null;
      activeAttemptWatermark: bigint | null;
      activeAttemptStartedAt: Date | null;
    }>>(Prisma.sql`
      select lane.lane_key as "laneKey", lane.bootstrap_state as "bootstrapState",
             lane.settled_watermark as "settledWatermark", lane.settled_at as "settledAt",
             lane.requested_watermark as "requestedWatermark", lane.requested_at as "requestedAt",
             lane.confirmed_watermark as "confirmedWatermark",
             lane.confirmed_publication_identity as "confirmedPublicationIdentity",
             lane.confirmed_receipt_sha256 as "confirmedReceiptSha256",
             lane.last_activated_watermark as "lastActivatedWatermark",
             lane.last_activated_at as "lastActivatedAt",
             lane.last_unchanged_watermark as "lastUnchangedWatermark",
             lane.last_unchanged_observed_at as "lastUnchangedObservedAt",
             lane.next_retry_at as "nextRetryAt",
             lane.delayed_vendor_count as "delayedVendorCount",
             attempt.id as "activeAttemptId", attempt.state as "activeAttemptState",
             attempt.target_watermark as "activeAttemptWatermark",
             attempt.created_at as "activeAttemptStartedAt"
      from public.promotion_lanes lane
      left join lateral (
        select id, state, target_watermark, created_at
        from public.promotion_attempts
        where organization_id = lane.organization_id
          and deployment_key = lane.deployment_key
          and lane_key = lane.lane_key
          and state in ('assembling', 'ready', 'in_progress', 'retry_wait')
        limit 1
      ) attempt on true
      where lane.organization_id = ${uuid(this.binding.organizationId)}
        and lane.deployment_key = ${this.binding.deploymentKey}
        and lane.lane_key = ${input.laneKey}
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      laneKey: row.laneKey,
      bootstrapState: row.bootstrapState,
      settledWatermark: row.settledWatermark,
      settledAt: row.settledAt,
      requestedWatermark: row.requestedWatermark,
      requestedAt: row.requestedAt,
      confirmedWatermark: row.confirmedWatermark,
      confirmedPublicationIdentity: row.confirmedPublicationIdentity,
      activeAttemptId: row.activeAttemptId,
      activeAttemptState: row.activeAttemptState,
      activeAttemptWatermark: row.activeAttemptWatermark,
      activeAttemptStartedAt: row.activeAttemptStartedAt,
      activeAttemptAgeMilliseconds: row.activeAttemptStartedAt === null
        ? null
        : Math.max(0, input.now.getTime() - row.activeAttemptStartedAt.getTime()),
      lastActivatedWatermark: row.lastActivatedWatermark,
      lastActivatedAt: row.lastActivatedAt,
      lastUnchangedWatermark: row.lastUnchangedWatermark,
      lastUnchangedObservedAt: row.lastUnchangedObservedAt,
      retryAt: row.nextRetryAt,
      delayedVendorCount: row.delayedVendorCount,
    };
  }

  private requireLaneInput(laneKey: string): void {
    requireBoundRepositoryKey(laneKey);
  }

  private toClaim(row: AttemptRow, recovered: boolean): PromotionAttemptClaim {
    if (row.claimToken === null || row.claimExpiresAt === null) {
      throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
    }
    return {
      attemptId: row.id,
      laneKey: row.laneKey,
      targetWatermark: row.targetWatermark,
      state: row.state,
      contentIdentity: row.contentIdentity,
      publicationIdentity: row.publicationIdentity,
      expectedPredecessorIdentity: row.expectedPredecessorIdentity,
      manifestSourceProofBody: row.manifestSourceProofBody,
      manifestSourceProofSha256: row.manifestSourceProofSha256,
      claimToken: row.claimToken,
      claimExpiresAt: row.claimExpiresAt,
      claimCount: row.claimCount,
      retryCount: row.retryCount,
      recovered,
    };
  }

  private requireOperations(operations: readonly PromotionOperationInput[]): void {
    if (operations.length === 0 || operations.length > maximumOperationCount) {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    const operationIds = new Set<string>();
    for (const [index, operation] of operations.entries()) {
      if (
        operation.operationIndex !== index
        || !operationIdPattern.test(operation.operationId)
        || !operationKindPattern.test(operation.operationKind)
        || !requestPathPattern.test(operation.requestPath)
        || operationIds.has(operation.operationId)
      ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
      operationIds.add(operation.operationId);
      requireJsonText(operation.canonicalRequestBody, maximumRequestBytes);
    }
  }

  private requireScope(scope: CatalogPromotionScope): void {
    if (
      scope.organizationId.toLowerCase() !== this.binding.organizationId.toLowerCase()
      || scope.deploymentKey !== this.binding.deploymentKey
      || scope.lane !== "catalog"
    ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
  }

  private preparedFromAttempt(
    attempt: AttemptRow,
  ): CatalogPromotionPreparedSummary | null {
    if (
      attempt.preparedClassification === null
      || attempt.publicationIdentity === null
      || attempt.contentIdentity === null
      || attempt.observationSequence === null
      || attempt.publicConfigHash === null
      || attempt.repackSearchIndexHash === null
      || attempt.preparedAt === null
    ) return null;
    return {
      classification: attempt.preparedClassification,
      publicReleaseId: attempt.publicationIdentity,
      requestedWatermark: attempt.targetWatermark,
      observationSequence: attempt.observationSequence,
      contentHash: attempt.contentIdentity,
      publicConfigHash: attempt.publicConfigHash,
      repackSearchIndexHash: attempt.repackSearchIndexHash,
      publicVendorKeys: attempt.publicVendorKeys,
      delayedVendorCount: attempt.delayedVendorCount,
      expectedPredecessorPublicReleaseId: attempt.expectedPredecessorIdentity,
    };
  }

  private async loadCatalogClaim(
    attemptId: string,
    claimToken: string,
  ): Promise<CatalogPromotionClaim> {
    const attempt = await this.loadBoundAttempt(attemptId);
    if (
      attempt === null
      || attempt.claimToken !== claimToken
      || attempt.claimExpiresAt === null
      || attempt.lastHeartbeatAt === null
    ) throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
    const operations = await this.loadOperations(this.database, attempt.id);
    return {
      attemptId: attempt.id,
      requestedWatermark: attempt.targetWatermark,
      claimToken,
      claimExpiresAt: attempt.claimExpiresAt,
      retryCount: attempt.retryCount,
      nextRetryAt: attempt.retryAt,
      createdAt: attempt.createdAt,
      startedAt: attempt.lastHeartbeatAt,
      prepared: this.preparedFromAttempt(attempt),
      operations: operations.map((operation) =>
        this.toCatalogOperation(attempt, operation)),
    };
  }

  private toCatalogOperation(
    attempt: AttemptRow,
    operation: OperationRow,
  ): CatalogPromotionOperation {
    if (
      attempt.publicationIdentity === null
      || !(operation.operationKind in pathByKind)
    ) throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
    const kind = operation.operationKind as CatalogPromotionOperation["kind"];
    if (operation.requestPath !== pathByKind[kind]) {
      throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
    }
    let receipt: ProductionReceipt | null = null;
    if (operation.receiptBody !== null) {
      try {
        receipt = productionReceiptSchema.parse(JSON.parse(operation.receiptBody));
      } catch {
        throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
      }
      if (
        receipt.operationId !== operation.operationId
        || receipt.requestDigest !== operation.requestSha256
      ) throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
    }
    return {
      ordinal: operation.operationIndex,
      kind,
      operationId: operation.operationId,
      publicationId: attempt.publicationIdentity,
      path: operation.requestPath as ProductionDataReleasePath,
      bodyJson: operation.canonicalRequestBody,
      bodyDigest: operation.requestSha256,
      dispatchCount: operation.sendCount,
      lastDispatchedAt: operation.lastSentAt,
      acknowledgedAt: operation.acknowledgedAt,
      receipt,
    };
  }

  private async loadBoundAttempt(attemptId: string): Promise<AttemptRow | null> {
    const rows = await this.database.$queryRaw<AttemptRow[]>(Prisma.sql`
      select id, lane_key as "laneKey", target_watermark as "targetWatermark", state,
             content_identity as "contentIdentity",
             publication_identity as "publicationIdentity",
             expected_predecessor_identity as "expectedPredecessorIdentity",
             prepared_classification as "preparedClassification",
             observation_sequence as "observationSequence",
             public_config_hash as "publicConfigHash",
             repack_search_index_hash as "repackSearchIndexHash",
             public_vendor_keys as "publicVendorKeys", prepared_at as "preparedAt",
             manifest_source_proof_body as "manifestSourceProofBody",
             manifest_source_proof_sha256 as "manifestSourceProofSha256",
             claim_token as "claimToken", claim_expires_at as "claimExpiresAt",
             last_heartbeat_at as "lastHeartbeatAt",
             claim_count as "claimCount", retry_count as "retryCount",
             retry_at as "retryAt", delayed_vendor_count as "delayedVendorCount",
             created_at as "createdAt"
      from public.promotion_attempts
      where id = ${uuid(attemptId)}
        and organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
    `);
    return rows[0] ?? null;
  }

  private async operationIdAtOrdinal(
    attemptId: string,
    ordinal: number,
  ): Promise<string | null> {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= maximumOperationCount) {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    const rows = await this.database.$queryRaw<Array<{ operationId: string }>>(Prisma.sql`
      select operation.operation_id as "operationId"
      from public.promotion_operations operation
      join public.promotion_attempts attempt on attempt.id = operation.attempt_id
      where attempt.id = ${uuid(attemptId)}
        and attempt.organization_id = ${uuid(this.binding.organizationId)}
        and attempt.deployment_key = ${this.binding.deploymentKey}
        and operation.operation_index = ${ordinal}
    `);
    return rows[0]?.operationId ?? null;
  }

  private async loadBoundOperationAtOrdinal(
    attemptId: string,
    ordinal: number,
  ): Promise<OperationRow | null> {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= maximumOperationCount) {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    const rows = await this.database.$queryRaw<OperationRow[]>(Prisma.sql`
      select operation.id, operation.operation_index as "operationIndex",
             operation.operation_id as "operationId",
             operation.operation_kind as "operationKind",
             operation.request_path as "requestPath",
             operation.canonical_request_body as "canonicalRequestBody",
             operation.request_sha256 as "requestSha256", operation.state,
             operation.send_count as "sendCount",
             operation.last_sent_at as "lastSentAt",
             operation.acknowledged_at as "acknowledgedAt",
             operation.receipt_body as "receiptBody",
             operation.receipt_sha256 as "receiptSha256"
      from public.promotion_operations operation
      join public.promotion_attempts attempt on attempt.id = operation.attempt_id
      where attempt.id = ${uuid(attemptId)}
        and attempt.organization_id = ${uuid(this.binding.organizationId)}
        and attempt.deployment_key = ${this.binding.deploymentKey}
        and operation.operation_index = ${ordinal}
    `);
    return rows[0] ?? null;
  }

  private async loadActiveHealthAttempt(
    attemptId: string,
  ): Promise<CatalogPromotionHealth["activeAttempt"]> {
    const rows = await this.database.$queryRaw<Array<{
      attemptId: string;
      requestedWatermark: bigint;
      state: PromotionAttemptState;
      createdAt: Date;
      claimExpiresAt: Date | null;
      claimToken: string | null;
    }>>(Prisma.sql`
      select id as "attemptId", target_watermark as "requestedWatermark", state,
             created_at as "createdAt", claim_expires_at as "claimExpiresAt",
             claim_token as "claimToken"
      from public.promotion_attempts
      where id = ${uuid(attemptId)}
        and organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
        and state in ('assembling', 'ready', 'in_progress', 'retry_wait')
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      attemptId: row.attemptId,
      requestedWatermark: row.requestedWatermark,
      state: row.state === "retry_wait"
        ? "retry_wait" : row.claimToken === null ? "pending" : "claimed",
      createdAt: row.createdAt,
      claimExpiresAt: row.claimExpiresAt,
    };
  }

  private lockLane(
    transaction: PackscoutTransactionClient,
    laneKey: string,
  ): Promise<LaneRow | null> {
    return transaction.$queryRaw<LaneRow[]>(Prisma.sql`
      select lane_key as "laneKey", bootstrap_state as "bootstrapState",
             settled_watermark as "settledWatermark", settled_at as "settledAt",
             requested_watermark as "requestedWatermark", requested_at as "requestedAt",
             confirmed_watermark as "confirmedWatermark",
             confirmed_publication_identity as "confirmedPublicationIdentity",
             confirmed_receipt_sha256 as "confirmedReceiptSha256",
             last_activated_watermark as "lastActivatedWatermark",
             last_activated_at as "lastActivatedAt",
             last_unchanged_watermark as "lastUnchangedWatermark",
             last_unchanged_observed_at as "lastUnchangedObservedAt",
             next_retry_at as "nextRetryAt", delayed_vendor_count as "delayedVendorCount"
      from public.promotion_lanes
      where organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
        and lane_key = ${laneKey}
      for update
    `).then((rows) => rows[0] ?? null);
  }

  private async lockActiveAttempt(
    transaction: PackscoutTransactionClient,
    laneKey: string,
  ): Promise<AttemptRow | null> {
    const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      select id, lane_key as "laneKey", target_watermark as "targetWatermark", state,
             content_identity as "contentIdentity",
             publication_identity as "publicationIdentity",
             expected_predecessor_identity as "expectedPredecessorIdentity",
             prepared_classification as "preparedClassification",
             observation_sequence as "observationSequence",
             public_config_hash as "publicConfigHash",
             repack_search_index_hash as "repackSearchIndexHash",
             public_vendor_keys as "publicVendorKeys", prepared_at as "preparedAt",
             manifest_source_proof_body as "manifestSourceProofBody",
             manifest_source_proof_sha256 as "manifestSourceProofSha256",
             claim_token as "claimToken", claim_expires_at as "claimExpiresAt",
             last_heartbeat_at as "lastHeartbeatAt",
             claim_count as "claimCount", retry_count as "retryCount", retry_at as "retryAt",
             delayed_vendor_count as "delayedVendorCount",
             created_at as "createdAt"
      from public.promotion_attempts
      where organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
        and lane_key = ${laneKey}
        and state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      for update
    `);
    return rows[0] ?? null;
  }

  private async lockClaimedAttempt(
    transaction: PackscoutTransactionClient,
    input: { attemptId: string; claimToken: string },
    now: Date,
  ): Promise<AttemptRow | null> {
    const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      select id, lane_key as "laneKey", target_watermark as "targetWatermark", state,
             content_identity as "contentIdentity",
             publication_identity as "publicationIdentity",
             expected_predecessor_identity as "expectedPredecessorIdentity",
             prepared_classification as "preparedClassification",
             observation_sequence as "observationSequence",
             public_config_hash as "publicConfigHash",
             repack_search_index_hash as "repackSearchIndexHash",
             public_vendor_keys as "publicVendorKeys", prepared_at as "preparedAt",
             manifest_source_proof_body as "manifestSourceProofBody",
             manifest_source_proof_sha256 as "manifestSourceProofSha256",
             claim_token as "claimToken", claim_expires_at as "claimExpiresAt",
             last_heartbeat_at as "lastHeartbeatAt",
             claim_count as "claimCount", retry_count as "retryCount", retry_at as "retryAt",
             delayed_vendor_count as "delayedVendorCount",
             created_at as "createdAt"
      from public.promotion_attempts
      where id = ${uuid(input.attemptId)}
        and organization_id = ${uuid(this.binding.organizationId)}
        and deployment_key = ${this.binding.deploymentKey}
      for update
    `);
    const attempt = rows[0];
    if (
      !attempt
      || attempt.claimToken !== input.claimToken
      || attempt.claimExpiresAt === null
      || attempt.claimExpiresAt <= now
      || !activeStates.includes(attempt.state)
    ) return null;
    return attempt;
  }

  private async lockLaneByAttempt(
    transaction: PackscoutTransactionClient,
    attemptId: string,
  ): Promise<LaneRow | null> {
    const rows = await transaction.$queryRaw<LaneRow[]>(Prisma.sql`
      select lane.lane_key as "laneKey", lane.bootstrap_state as "bootstrapState",
             lane.settled_watermark as "settledWatermark", lane.settled_at as "settledAt",
             lane.requested_watermark as "requestedWatermark", lane.requested_at as "requestedAt",
             lane.confirmed_watermark as "confirmedWatermark",
             lane.confirmed_publication_identity as "confirmedPublicationIdentity",
             lane.confirmed_receipt_sha256 as "confirmedReceiptSha256",
             lane.last_activated_watermark as "lastActivatedWatermark",
             lane.last_activated_at as "lastActivatedAt",
             lane.last_unchanged_watermark as "lastUnchangedWatermark",
             lane.last_unchanged_observed_at as "lastUnchangedObservedAt",
             lane.next_retry_at as "nextRetryAt",
             lane.delayed_vendor_count as "delayedVendorCount"
      from public.promotion_lanes lane
      join public.promotion_attempts attempt
        on attempt.organization_id = lane.organization_id
       and attempt.deployment_key = lane.deployment_key
       and attempt.lane_key = lane.lane_key
      where attempt.id = ${uuid(attemptId)}
        and lane.organization_id = ${uuid(this.binding.organizationId)}
        and lane.deployment_key = ${this.binding.deploymentKey}
      for update of lane
    `);
    return rows[0] ?? null;
  }

  private loadOperations(
    transaction: PackscoutQueryClient,
    attemptId: string,
  ): Promise<OperationRow[]> {
    return transaction.$queryRaw<OperationRow[]>(Prisma.sql`
      select id, operation_index as "operationIndex", operation_id as "operationId",
             operation_kind as "operationKind", request_path as "requestPath",
             canonical_request_body as "canonicalRequestBody",
             request_sha256 as "requestSha256", state,
             send_count as "sendCount", last_sent_at as "lastSentAt",
             acknowledged_at as "acknowledgedAt", receipt_body as "receiptBody",
             receipt_sha256 as "receiptSha256"
      from public.promotion_operations
      where attempt_id = ${uuid(attemptId)}
      order by operation_index
    `);
  }

  private async lockOperation(
    transaction: PackscoutTransactionClient,
    attemptId: string,
    operationId: string,
  ): Promise<OperationRow | null> {
    const rows = await transaction.$queryRaw<OperationRow[]>(Prisma.sql`
      select id, operation_index as "operationIndex", operation_id as "operationId",
             operation_kind as "operationKind", request_path as "requestPath",
             canonical_request_body as "canonicalRequestBody",
             request_sha256 as "requestSha256", state,
             send_count as "sendCount", last_sent_at as "lastSentAt",
             acknowledged_at as "acknowledgedAt", receipt_body as "receiptBody",
             receipt_sha256 as "receiptSha256"
      from public.promotion_operations
      where attempt_id = ${uuid(attemptId)} and operation_id = ${operationId}
      for update
    `);
    return rows[0] ?? null;
  }

  private async assertFirstUnacknowledged(
    transaction: PackscoutTransactionClient,
    attemptId: string,
    operationIndex: number,
  ): Promise<void> {
    const lower = await transaction.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      select exists (
        select 1 from public.promotion_operations
        where attempt_id = ${uuid(attemptId)}
          and operation_index < ${operationIndex}
          and state <> 'acknowledged'
      ) as exists
    `);
    if (lower[0]?.exists) {
      throw new PromotionLedgerError("PROMOTION_OPERATION_ORDER_INVALID");
    }
  }
}
