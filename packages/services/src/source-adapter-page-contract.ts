import type {
  NormalizedProviderObservationPage,
  SourceAdapterFailure,
  SourceAdapterSafeDiagnostic,
} from "@packscout/contracts";
import type { SourceAdapterRequestCaptureV1 } from "./source-adapter.ts";

export const CAPTURED_SOURCE_PAGE_VERSION =
  "packscout.captured-source-page.v1" as const;

export interface CapturedSourcePageV1 {
  readonly captureVersion: typeof CAPTURED_SOURCE_PAGE_VERSION;
  readonly requestCapture: SourceAdapterRequestCaptureV1;
  /** Protected page-local evidence referenced by normalized outcomes. */
  readonly protectedNativeEvidence: readonly Readonly<{
    reference: string;
    value: Readonly<Record<string, unknown>>;
  }>[];
  readonly normalizedPage: NormalizedProviderObservationPage;
}

export type InterpretedNormalizedProviderObservationPage = Omit<
  NormalizedProviderObservationPage,
  "measurements" | "diagnostics"
>;

export interface InterpretedSourcePageV1 {
  readonly protectedNativeEvidence: CapturedSourcePageV1["protectedNativeEvidence"];
  readonly normalizedPage: InterpretedNormalizedProviderObservationPage;
}

export type SourceAdapterPageInterpretationResult =
  | Readonly<{
      ok: true;
      value: InterpretedSourcePageV1;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      failure: SourceAdapterFailure;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>;
