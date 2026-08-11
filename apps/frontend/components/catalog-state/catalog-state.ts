export const CATALOG_STATE_COPY = Object.freeze({
  loading: "Loading pack data.",
  updating: "Updating results…",
  unavailable: "Pack data is temporarily unavailable.",
  empty: "Pack data is not available yet.",
  noMatches: "No packs match these filters.",
  retry: "Retry",
  clearFilters: "Clear filters",
  retainedFailure: "Could not refresh. Showing your previous results.",
  retryPending: "Retrying pack data…",
  retrySucceeded: "Pack data refreshed.",
  retryFailed: "Pack data is still unavailable.",
  clearPending: "Clearing filters…",
  clearSucceeded: "Filters cleared.",
  clearFailed: "Could not clear filters. Your current filters are unchanged.",
} as const);

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
      return `${update.visibleCount} ${update.visibleCount === 1 ? "pack" : "packs"} shown.`;
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
