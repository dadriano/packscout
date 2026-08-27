export function shouldApplyDesiredCollectibleSearchResults(
  input: Readonly<{ aborted: boolean; dismissed: boolean }>,
): boolean {
  return !input.aborted && !input.dismissed;
}

export type DesiredCollectibleSearchStatus =
  | "idle"
  | "loading"
  | "ready"
  | "failed";

/**
 * Keeps the exact selected collectible authoritative over stale async search
 * state. A response can settle in the same render window as a selection; the
 * live region must announce the selection instead of continuing to say that
 * a search is running after the result page has already loaded.
 */
export function desiredCollectibleSearchStatusCopy(input: Readonly<{
  exactSelectedName: boolean;
  optionCount: number;
  searchable: boolean;
  selectedIdentity: string | null;
  status: DesiredCollectibleSearchStatus;
}>): string {
  if (input.exactSelectedName && input.selectedIdentity !== null) {
    return `Selected desired chase: ${input.selectedIdentity}.`;
  }
  if (!input.searchable && input.selectedIdentity === null) {
    return "Type at least 2 characters, then choose an exact collectible.";
  }
  if (input.status === "loading") return "Searching collectibles…";
  if (input.status === "failed") {
    return "Collectible search is temporarily unavailable.";
  }
  if (input.status === "ready" && input.optionCount === 0) {
    return "No collectible matches found.";
  }
  if (input.selectedIdentity !== null) {
    return `Current desired chase remains ${input.selectedIdentity} until you choose a replacement or clear it.`;
  }
  return "Choose an exact collectible from the results.";
}
