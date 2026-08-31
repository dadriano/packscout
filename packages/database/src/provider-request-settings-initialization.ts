import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { providerMixedPageCanonicalBytes, providerMixedPageDigest } from "./provider-mixed-page-contract.ts";

export interface ProviderRequestSettingsInitializationBoundary {
  readonly expectedGeneration: bigint;
  readonly expectedCursorFingerprint: string | null;
  readonly expectedImportFence: bigint;
  readonly parentRunId: string;
  readonly deadline: Date;
}

export class ProviderRequestSettingsInitializationExpired extends Error {
  constructor() { super("Provider request settings initialization deadline expired."); }
}

export async function assertRequestSettingsInitializationDeadline(transaction: ProviderTransactionClient, deadline: Date): Promise<void> {
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(ProviderPrisma.sql`select clock_timestamp() as now`);
  if (clock === undefined || clock.now >= deadline) throw new ProviderRequestSettingsInitializationExpired();
}

export function validateRequestSettingsInitializationBoundary(input: ProviderRequestSettingsInitializationBoundary): void {
  if (typeof input.expectedGeneration !== "bigint" || input.expectedGeneration < 0n
    || typeof input.expectedImportFence !== "bigint" || input.expectedImportFence < 0n
    || !(input.deadline instanceof Date) || !Number.isFinite(input.deadline.getTime())
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.parentRunId)
    || (input.expectedCursorFingerprint !== null && !/^[0-9a-f]{64}$/u.test(input.expectedCursorFingerprint))) {
    throw new TypeError("Provider request settings initialization boundary is invalid.");
  }
}

/** Caller holds import -> promotion -> runtime locks until the setting/audit commit. */
export async function requestSettingsInitializationAdmitted(transaction: ProviderTransactionClient, input: {
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly boundary: ProviderRequestSettingsInitializationBoundary;
  readonly importFence: bigint;
}): Promise<boolean> {
  const { boundary } = input;
  if (input.importFence !== boundary.expectedImportFence) return false;
  const runtime = await transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
  if (runtime.state_generation !== boundary.expectedGeneration
    || runtime.source_cursor_hash !== boundary.expectedCursorFingerprint
    || (runtime.source_cursor === null ? null : providerMixedPageDigest(runtime.source_cursor)) !== boundary.expectedCursorFingerprint) return false;
  const parent = await transaction.provider_runs.findUnique({ where: { id: boundary.parentRunId } });
  if (!parent || parent.state !== "failed" || parent.finished_at === null || parent.page_count < 1
    || parent.config_version_id !== input.configVersionId || parent.config_version_number !== input.configVersionNumber
    || parent.final_cursor_hash !== boundary.expectedCursorFingerprint
    || !providerMixedPageCanonicalBytes(parent.final_cursor).equals(providerMixedPageCanonicalBytes(runtime.source_cursor))) return false;
  const lastPage = await transaction.provider_run_pages.findFirst({
    where: { provider_run_id: parent.id }, orderBy: { page_number: "desc" },
  });
  if (!lastPage || lastPage.page_number !== parent.page_count
    || lastPage.next_cursor_hash !== boundary.expectedCursorFingerprint
    || !providerMixedPageCanonicalBytes(lastPage.next_cursor).equals(providerMixedPageCanonicalBytes(runtime.source_cursor))) return false;
  if (await transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }) !== 0
    || await transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }) !== 0) return false;
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(ProviderPrisma.sql`select clock_timestamp() as now`);
  return clock !== undefined && clock.now < boundary.deadline;
}
