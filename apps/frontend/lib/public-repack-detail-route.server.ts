import type { GetPublicRepackInput } from "@packscout/contracts";
import { parsePublicRepackDetailRequest } from "./public-repack-detail";
import type {
  GetPublicRepackV3Result,
  GetPublicShellStatusV3Result,
} from "./public-repacks-v3";

type ReadPublicShellStatus = () => Promise<GetPublicShellStatusV3Result>;
type ReadPublicRepack = (
  input: GetPublicRepackInput,
) => Promise<GetPublicRepackV3Result>;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function statusForCode(code: string): number {
  if (code === "RELEASE_UNAVAILABLE") return 503;
  if (code === "REPACK_NOT_FOUND") return 404;
  return 400;
}

export function createPublicRepackDetailHandler(
  readPublicShellStatus: ReadPublicShellStatus,
  readPublicRepack: ReadPublicRepack,
): (request: Request) => Promise<Response> {
  return async function publicRepackDetail(request: Request) {
    const parsed = parsePublicRepackDetailRequest(request.url);
    if (!parsed.ok) {
      return json(
        {
          ok: false,
          code: "INVALID_QUERY",
          error: "Repack details request is invalid.",
          retryable: false,
        },
        400,
      );
    }

    const shell = await readPublicShellStatus();
    if (!shell.ok) {
      return json(shell, statusForCode(shell.code));
    }

    const result = await readPublicRepack({
      publicRepackId: parsed.input.publicRepackId,
      publicReleaseId: shell.data.release.publicReleaseId,
    });
    if (!result.ok) {
      return json(result, statusForCode(result.code));
    }
    return json(
      {
        ok: true,
        data: {
          release: shell.data.release,
          repack: result.data,
        },
      },
      200,
    );
  };
}
