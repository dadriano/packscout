import { createHash } from "node:crypto";
import {
  providerSourceSuccessfulCaptureCanonicalJson,
  type SourceAdapterSafeDiagnostic,
} from "@packscout/contracts";

export function providerSourceSuccessfulCaptureOutcomeHash(
  outcome: Readonly<{
    ok: true;
    protectedRawResponseSha256: string;
    measurements: Readonly<{
      responseBytes: number;
      durationMilliseconds: number;
    }>;
    diagnostics: readonly SourceAdapterSafeDiagnostic[];
  }>,
): string {
  return createHash("sha256")
    .update(providerSourceSuccessfulCaptureCanonicalJson({
      protectedRawResponseSha256: outcome.protectedRawResponseSha256,
      responseBytes: outcome.measurements.responseBytes,
      durationMilliseconds: outcome.measurements.durationMilliseconds,
    }))
    .digest("hex");
}
