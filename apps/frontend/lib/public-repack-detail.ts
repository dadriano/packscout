import {
  dataReleaseV3IdentitySchema,
  publicReadError,
  publicReadErrorSchema,
  publicRepackIdSchema,
  publicRepackViewDetailV3Schema,
  type DataReleaseV3Identity,
  type GetPublicRepackInput,
  type PublicRepackViewDetailV3,
  type PublicResult,
} from "@packscout/contracts";
import { parseGetPublicRepackV3Result } from "./public-repacks-v3";

export type PublicRepackDetailPage = Readonly<{
  release: DataReleaseV3Identity;
  repack: PublicRepackViewDetailV3;
}>;

export type PublicRepackDetailParseResult =
  | Readonly<{ ok: true; input: Pick<GetPublicRepackInput, "publicRepackId"> }>
  | Readonly<{ ok: false }>;

const REPACK_DETAIL_PATH = /^\/api\/repacks\/([^/]+)\/?$/;

export function parsePublicRepackDetailRequest(
  requestUrl: string,
): PublicRepackDetailParseResult {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false };
  }
  if ([...url.searchParams.keys()].length > 0) {
    return { ok: false };
  }
  const pathMatch = REPACK_DETAIL_PATH.exec(url.pathname);
  if (pathMatch === null) return { ok: false };
  const publicRepackId = publicRepackIdSchema.safeParse(pathMatch[1]);
  if (!publicRepackId.success) return { ok: false };
  return { ok: true, input: { publicRepackId: publicRepackId.data } };
}

export function parsePublicRepackDetailResponse(
  input: unknown,
): PublicResult<PublicRepackDetailPage> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
  const envelope = input as { ok?: unknown; data?: unknown };
  if (envelope.ok === false) {
    const parsed = publicReadErrorSchema.safeParse(input);
    return parsed.success ? parsed.data : publicReadError("RELEASE_UNAVAILABLE");
  }
  if (envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
  const payload = envelope.data as { release?: unknown; repack?: unknown };
  const release = dataReleaseV3IdentitySchema.safeParse(payload.release);
  const repack = parseGetPublicRepackV3Result({ ok: true, data: payload.repack });
  if (!release.success || !repack.ok) {
    return publicReadError("RELEASE_UNAVAILABLE");
  }
  const detail = publicRepackViewDetailV3Schema.safeParse(repack.data);
  if (!detail.success) return publicReadError("RELEASE_UNAVAILABLE");
  return { ok: true, data: { release: release.data, repack: detail.data } };
}
