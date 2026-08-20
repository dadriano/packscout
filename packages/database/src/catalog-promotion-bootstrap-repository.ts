import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import {
  PromotionLedgerError,
  promotionUuid as uuid,
  requireBoundRepositoryKey,
  sha256,
  sha256Pattern,
  type PromotionBootstrapState,
} from "./catalog-promotion-ledger.ts";

type PromotionRepositoryBinding = Readonly<{
  organizationId: string;
  deploymentKey: string;
}>;

export interface VerifyPromotionBootstrapInput {
  readonly laneKey: string;
  readonly observedPublicationIdentity: string | null;
  readonly observedWatermark: bigint;
  readonly observedReceiptSha256: string | null;
  readonly verifiedAt: Date;
}

export async function loadPromotionBootstrapState(
  database: PackscoutPrismaClient,
  binding: PromotionRepositoryBinding,
  laneKey: string,
): Promise<PromotionBootstrapState> {
  requireBoundRepositoryKey(laneKey);
  const rows = await database.$queryRaw<Array<{
    bootstrapState: PromotionBootstrapState;
  }>>(Prisma.sql`
    select bootstrap_state as "bootstrapState"
    from public.promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
      and lane_key = ${laneKey}
  `);
  return rows[0]?.bootstrapState ?? "unverified";
}

export async function verifyPromotionBootstrap(
  database: PackscoutPrismaClient,
  binding: PromotionRepositoryBinding,
  input: VerifyPromotionBootstrapInput,
): Promise<void> {
  requireBoundRepositoryKey(input.laneKey);
  if (
    input.observedWatermark < 0n
    || !Number.isFinite(input.verifiedAt.getTime())
    || ((input.observedPublicationIdentity === null) !==
      (input.observedWatermark === 0n))
    || ((input.observedPublicationIdentity === null) !==
      (input.observedReceiptSha256 === null))
    || (input.observedReceiptSha256 !== null
      && !sha256Pattern.test(input.observedReceiptSha256))
  ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");

  await database.$transaction(async (transaction) => {
    const lanes = await transaction.$queryRaw<Array<{
      bootstrapState: PromotionBootstrapState;
      confirmedWatermark: bigint;
      confirmedPublicationIdentity: string | null;
      lastActivatedWatermark: bigint;
    }>>(Prisma.sql`
      select bootstrap_state as "bootstrapState",
             confirmed_watermark as "confirmedWatermark",
             confirmed_publication_identity as "confirmedPublicationIdentity",
             last_activated_watermark as "lastActivatedWatermark"
      from public.promotion_lanes
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
        and lane_key = ${input.laneKey}
      for update
    `);
    const lane = lanes[0];
    if (!lane) throw new PromotionLedgerError("PROMOTION_BOOTSTRAP_UNVERIFIED");

    // Another startup may have verified the lane and begun a remote operation
    // while this startup was inspecting the remote pointer. Its stale probe is
    // no longer authoritative and must not invalidate the durable local state.
    if (lane.bootstrapState !== "unverified") return;

    if (input.observedPublicationIdentity === null) {
      if (
        lane.confirmedWatermark !== 0n
        || lane.confirmedPublicationIdentity !== null
      ) throw new PromotionLedgerError("PROMOTION_BOOTSTRAP_CONFLICT");
      await transaction.$executeRaw(Prisma.sql`
        update public.promotion_lanes
        set bootstrap_state = 'verified_empty',
            bootstrap_verified_at = ${input.verifiedAt},
            updated_at = ${input.verifiedAt}
        where organization_id = ${uuid(binding.organizationId)}
          and deployment_key = ${binding.deploymentKey}
          and lane_key = ${input.laneKey}
      `);
      return;
    }

    const provenRows = await transaction.$queryRaw<Array<{
      state: "published" | "unchanged";
      terminalAt: Date;
      terminalReceiptBody: string;
      terminalReceiptSha256: string;
    }>>(Prisma.sql`
      select state, terminal_at as "terminalAt",
             terminal_receipt_body as "terminalReceiptBody",
             terminal_receipt_sha256 as "terminalReceiptSha256"
      from public.promotion_attempts
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
        and lane_key = ${input.laneKey}
        and state in ('published', 'unchanged')
        and target_watermark = ${input.observedWatermark}
        and publication_identity = ${input.observedPublicationIdentity}
      limit 1
    `);
    const proven = provenRows[0];
    if (
      !proven
      || proven.terminalReceiptSha256 !== input.observedReceiptSha256
      || sha256(proven.terminalReceiptBody) !== input.observedReceiptSha256
    ) throw new PromotionLedgerError("PROMOTION_BOOTSTRAP_UNPROVEN");
    if (
      lane.lastActivatedWatermark > input.observedWatermark
      || (lane.confirmedPublicationIdentity !== null
        && lane.confirmedPublicationIdentity !== input.observedPublicationIdentity)
    ) throw new PromotionLedgerError("PROMOTION_BOOTSTRAP_CONFLICT");

    await transaction.$executeRaw(Prisma.sql`
      update public.promotion_lanes
      set bootstrap_state = 'verified_local',
          bootstrap_verified_at = ${input.verifiedAt},
          confirmed_watermark = greatest(
            confirmed_watermark, ${input.observedWatermark}
          ),
          confirmed_publication_identity = ${input.observedPublicationIdentity},
          confirmed_receipt_sha256 = case
            when ${input.observedWatermark} >= confirmed_watermark
              then ${input.observedReceiptSha256}
            else confirmed_receipt_sha256
          end,
          last_activated_watermark = case
            when ${proven.state} = 'published'
              then greatest(last_activated_watermark, ${input.observedWatermark})
            else last_activated_watermark
          end,
          last_activated_at = case
            when ${proven.state} = 'published'
              and ${input.observedWatermark} >= last_activated_watermark
              then ${proven.terminalAt}
            else last_activated_at
          end,
          last_unchanged_watermark = case
            when ${proven.state} = 'unchanged'
              then greatest(
                coalesce(last_unchanged_watermark, 0),
                ${input.observedWatermark}
              )
            else last_unchanged_watermark
          end,
          last_unchanged_observed_at = case
            when ${proven.state} = 'unchanged'
              and (
                last_unchanged_watermark is null
                or ${input.observedWatermark} >= last_unchanged_watermark
              ) then ${proven.terminalAt}
            else last_unchanged_observed_at
          end,
          updated_at = ${input.verifiedAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
        and lane_key = ${input.laneKey}
    `);
  }, PACKSCOUT_TRANSACTION_OPTIONS);
}
