import type { FindRepacksByDesiredCollectibleInput } from "@packscout/contracts";
import { parseDesiredCollectibleRepacksRequest } from "./desired-collectible-repacks";
import type { FindRepacksByDesiredCollectibleV3Result } from "./public-repacks-v3";

type ReadRepacksByDesiredCollectible = (
  input: FindRepacksByDesiredCollectibleInput,
) => Promise<FindRepacksByDesiredCollectibleV3Result>;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function createDesiredCollectibleRepacksHandler(
  readRepacksByDesiredCollectible: ReadRepacksByDesiredCollectible,
): (request: Request) => Promise<Response> {
  return async function desiredCollectibleRepacks(request: Request) {
    const parsed = parseDesiredCollectibleRepacksRequest(request.url);
    if (!parsed.ok) {
      return json(
        {
          ok: false,
          code: "INVALID_QUERY",
          error: "Chase details request is invalid.",
          retryable: false,
        },
        400,
      );
    }

    const result = await readRepacksByDesiredCollectible(parsed.input);
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
