import { dataforrestDistributedRunRequestPinSchema } from "@packscout/contracts";
import type { ProviderRunSummary } from "@packscout/database";
import type { ProviderCaptureAuthority } from "./provider-capture-source-contract.ts";

/** Never consult the current setting to repair or replace a historical run pin. */
export function readProviderRunRequestPin(
  run: Pick<ProviderRunSummary, "configVersionId" | "configVersionNumber" |
    "recordsPerRequest" | "requestSettingsRevisionId">,
  authority: Pick<ProviderCaptureAuthority, "configVersionId" | "configVersionNumber">,
) {
  if (run.configVersionId !== authority.configVersionId ||
    run.configVersionNumber !== authority.configVersionNumber) return null;
  const pin = dataforrestDistributedRunRequestPinSchema.safeParse({
    recordsPerRequest: run.recordsPerRequest,
    requestSettingsRevisionId: run.requestSettingsRevisionId,
  });
  return pin.success ? Object.freeze(pin.data) : null;
}
