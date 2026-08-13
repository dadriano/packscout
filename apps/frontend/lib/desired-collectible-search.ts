import {
  searchPublicCollectiblesInputSchema,
  type SearchPublicCollectiblesInput,
} from "@packscout/contracts";

export type DesiredCollectibleSearchParseResult =
  | Readonly<{ ok: true; input: SearchPublicCollectiblesInput }>
  | Readonly<{ ok: false }>;

export function parseDesiredCollectibleSearchRequest(
  requestUrl: string,
): DesiredCollectibleSearchParseResult {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false };
  }
  if (
    [...url.searchParams.keys()].some((key) => key !== "q") ||
    url.searchParams.getAll("q").length !== 1
  ) {
    return { ok: false };
  }
  const parsed = searchPublicCollectiblesInputSchema.safeParse({
    search: url.searchParams.get("q"),
    limit: 20,
  });
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false };
}
