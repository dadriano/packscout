/** Five million source records at the live-census Courtyard page profile. */
export const PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES = 50_000;

export function providerManualImportPageNumberWithinBound(
  pageNumber: number,
): boolean {
  return Number.isSafeInteger(pageNumber)
    && pageNumber >= 1
    && pageNumber <= PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES;
}
