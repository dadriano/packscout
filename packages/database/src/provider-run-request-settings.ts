import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { providerMixedPageCanonicalBytes, providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import type { ProviderRequestSettingsPolicy } from "./provider-request-settings-repository.ts";

/** Explicit non-network capture capability, available only before request-policy cutover. */
export async function unmanagedProviderRequestSettingsAllowed(transaction: ProviderTransactionClient): Promise<boolean> {
  return await transaction.provider_request_settings.findUnique({ where: { singleton_key: true } }) === null;
}

export async function providerRunRequestPinIsUsable(transaction: ProviderTransactionClient, input: {
  readonly recordsPerRequest: number | null;
  readonly requestSettingsRevisionId: string | null;
  readonly requestSettingsPolicy?: ProviderRequestSettingsPolicy;
}): Promise<boolean> {
  if (input.requestSettingsPolicy === "unmanaged") return input.recordsPerRequest === null
    && input.requestSettingsRevisionId === null && await unmanagedProviderRequestSettingsAllowed(transaction);
  return input.recordsPerRequest !== null && input.requestSettingsRevisionId !== null;
}

export async function recoveryProviderRequestSettings(transaction: ProviderTransactionClient, input: {
  readonly parentRunId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly cursor: ProviderPrisma.JsonValue | null;
  readonly cursorFingerprint: string | null;
  readonly expectedCursorFingerprint: string | null | undefined;
  readonly requestSettingsPolicy?: ProviderRequestSettingsPolicy;
}): Promise<{ readonly id: string | null; readonly recordsPerRequest: number | null } | null> {
  if (input.expectedCursorFingerprint === undefined
    || input.cursorFingerprint !== input.expectedCursorFingerprint
    || (input.cursor === null ? null : providerMixedPageDigest(input.cursor)) !== input.cursorFingerprint) return null;
  const parent = await transaction.provider_runs.findUnique({ where: { id: input.parentRunId } });
  if (!parent || !["failed", "incomplete", "succeeded"].includes(parent.state)
    || parent.finished_at === null
    || parent.config_version_id !== input.configVersionId || parent.config_version_number !== input.configVersionNumber
    || parent.final_cursor_hash !== input.cursorFingerprint
    || !providerMixedPageCanonicalBytes(parent.final_cursor).equals(providerMixedPageCanonicalBytes(input.cursor))) return null;
  if (!await providerRunRequestPinIsUsable(transaction, {
    recordsPerRequest: parent.records_per_request, requestSettingsRevisionId: parent.request_settings_revision_id,
    requestSettingsPolicy: input.requestSettingsPolicy,
  })) return null;
  return { id: parent.request_settings_revision_id, recordsPerRequest: parent.records_per_request };
}

/** The source audit counts wire observations; canonical expansion has its own independent cap. */
export async function providerPageRequestSettingsFailure(transaction: ProviderTransactionClient, input: {
  readonly pageId: string;
  readonly runId: string;
  readonly pageNumber: number;
  readonly workerFence: bigint;
  readonly responseDigest: string;
  readonly normalizedRecordCount: number;
  readonly recordsPerRequest: number | null;
  readonly requestSettingsRevisionId: string | null;
  readonly requestSettingsPolicy?: ProviderRequestSettingsPolicy;
}): Promise<"request_settings_unavailable" | "source_receipt_missing" | null> {
  if (!await providerRunRequestPinIsUsable(transaction, input)) return "request_settings_unavailable";
  if (input.requestSettingsPolicy === "unmanaged") return null;
  const [result] = await transaction.$queryRaw<Array<{ admitted: boolean }>>(ProviderPrisma.sql`
    select packscout_page_has_request_receipt(
      ${input.pageId}::uuid, ${input.runId}::uuid, ${input.pageNumber}::integer,
      ${input.workerFence}::bigint, ${input.responseDigest}::text, ${input.normalizedRecordCount}::integer,
      ${input.recordsPerRequest}::integer, ${input.requestSettingsRevisionId}::uuid
    ) as admitted
  `);
  return result?.admitted === true ? null : "source_receipt_missing";
}
