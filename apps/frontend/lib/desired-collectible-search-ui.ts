export function shouldApplyDesiredCollectibleSearchResults(
  input: Readonly<{ aborted: boolean; dismissed: boolean }>,
): boolean {
  return !input.aborted && !input.dismissed;
}
