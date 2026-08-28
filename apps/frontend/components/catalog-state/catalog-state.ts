import type { PublicReadError, PublicReadErrorCode } from "@packscout/contracts";

export const CATALOG_STATE_COPY = Object.freeze({
  loading: "Loading repack data.",
  updating: "Updating results…",
  unavailable: "Repack data is temporarily unavailable.",
  empty: "Repack data is not available yet.",
  noMatches: "No repacks match these filters.",
  retry: "Retry",
  clearFilters: "Clear filters",
  retainedFailure: "Could not refresh. Showing your previous results.",
  retryPending: "Retrying repack data…",
  retrySucceeded: "Repack data refreshed.",
  retryFailed: "Repack data is still unavailable.",
  clearPending: "Clearing filters…",
  clearSucceeded: "Filters cleared.",
  clearFailed: "Could not clear filters. Your current filters are unchanged.",
} as const);

type NonRetryablePublicReadErrorCode = Exclude<
  PublicReadErrorCode,
  "RELEASE_UNAVAILABLE"
>;

export type CatalogResultRecoveryPresentation =
  | Readonly<{ kind: "retry" }>
  | Readonly<{
      kind: "navigate";
      eyebrow: string;
      title: string;
      description: string;
      actionLabel: string;
    }>;

const NON_RETRYABLE_RESULT_COPY = Object.freeze({
  INVALID_QUERY: Object.freeze({
    eyebrow: "Catalog link",
    title: "This repack catalog link cannot be applied",
    description: "Reset the catalog to remove unsupported query state.",
    actionLabel: "Reset repack catalog",
  }),
  CURSOR_EXPIRED: Object.freeze({
    eyebrow: "Catalog page",
    title: "This repack page has expired",
    description: "Return to the first page with your accepted filters preserved.",
    actionLabel: "Return to first page",
  }),
  REPACK_NOT_FOUND: Object.freeze({
    eyebrow: "Repack selection",
    title: "This selected repack is no longer available",
    description: "Clear the selection to continue browsing the catalog.",
    actionLabel: "Clear repack selection",
  }),
  COLLECTIBLE_NOT_FOUND: Object.freeze({
    eyebrow: "Desired chase",
    title: "This desired chase is no longer available",
    description: "Clear the desired chase to continue with your other catalog filters.",
    actionLabel: "Clear desired chase",
  }),
} satisfies Readonly<
  Record<
    NonRetryablePublicReadErrorCode,
    Readonly<{
      eyebrow: string;
      title: string;
      description: string;
      actionLabel: string;
    }>
  >
>);

export function catalogResultRecoveryPresentation(
  error: PublicReadError,
): CatalogResultRecoveryPresentation {
  if (error.code === "RELEASE_UNAVAILABLE") return { kind: "retry" };
  return { kind: "navigate", ...NON_RETRYABLE_RESULT_COPY[error.code] };
}

export type CatalogConstraint = Readonly<{
  label: string;
  value: string;
}>;

export type RecoverableActionState =
  | "idle"
  | "pending"
  | "succeeded"
  | "failed";

export type RecoverableActionEvent = "start" | "succeed" | "fail";

export type CatalogUpdateState =
  | { readonly state: "idle" }
  | { readonly state: "updating" }
  | { readonly state: "failed" }
  | { readonly state: "updated"; readonly visibleCount: number };

export function catalogUpdateMessage(update: CatalogUpdateState): string {
  switch (update.state) {
    case "idle":
      return "";
    case "updating":
      return CATALOG_STATE_COPY.updating;
    case "failed":
      return CATALOG_STATE_COPY.retainedFailure;
    case "updated":
      return `${update.visibleCount} ${update.visibleCount === 1 ? "repack" : "repacks"} shown.`;
  }
}

export function recoveryMessage(
  state: RecoverableActionState,
  messages: Readonly<{
    pending: string;
    succeeded: string;
    failed: string;
  }>,
): string {
  if (state === "pending") return messages.pending;
  if (state === "succeeded") return messages.succeeded;
  if (state === "failed") return messages.failed;
  return "";
}

export function reduceRecoverableActionState(
  state: RecoverableActionState,
  event: RecoverableActionEvent,
): RecoverableActionState {
  if (event === "start") return "pending";
  if (state !== "pending") return state;
  return event === "succeed" ? "succeeded" : "failed";
}

export function usableConstraints(
  constraints: readonly CatalogConstraint[],
): readonly CatalogConstraint[] {
  return constraints.flatMap(({ label, value }) => {
    const cleanLabel = label.trim();
    const cleanValue = value.trim();
    return cleanLabel && cleanValue
      ? [{ label: cleanLabel, value: cleanValue }]
      : [];
  });
}
