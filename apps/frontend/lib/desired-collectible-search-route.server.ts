import type {
  SearchPublicCollectiblesInput,
  SearchPublicCollectiblesResult,
} from "@packscout/contracts";
import { parseDesiredCollectibleSearchRequest } from "./desired-collectible-search";

type SearchPublicCollectibles = (
  input: SearchPublicCollectiblesInput,
) => Promise<SearchPublicCollectiblesResult>;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function createDesiredCollectibleSearchHandler(
  searchPublicCollectibles: SearchPublicCollectibles,
): (request: Request) => Promise<Response> {
  return async function desiredCollectibleSearch(request: Request) {
    const parsed = parseDesiredCollectibleSearchRequest(request.url);
    if (!parsed.ok) {
      return json(
        {
          ok: false,
          code: "INVALID_QUERY",
          error: "Collectible search is invalid.",
          retryable: false,
        },
        400,
      );
    }

    const result = await searchPublicCollectibles(parsed.input);
    if (!result.ok) {
      const status = result.code === "RELEASE_UNAVAILABLE"
        ? 503
        : result.code === "COLLECTIBLE_NOT_FOUND"
          ? 404
          : 400;
      return json(result, status);
    }
    return json(result, 200);
  };
}
