import {
  PUBLIC_REPACK_MAX_PAGE_SIZE,
  findRepacksByDesiredCollectibleInputSchema,
  publicCollectibleIdSchema,
  type FindRepacksByDesiredCollectibleInput,
} from "@packscout/contracts";

export type DesiredCollectibleRepacksParseResult =
  | Readonly<{ ok: true; input: FindRepacksByDesiredCollectibleInput }>
  | Readonly<{ ok: false }>;

const COLLECTIBLE_REPACKS_PATH =
  /^\/api\/collectibles\/([^/]+)\/repacks\/?$/;

export function parseDesiredCollectibleRepacksRequest(
  requestUrl: string,
): DesiredCollectibleRepacksParseResult {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false };
  }
  if ([...url.searchParams.keys()].length > 0) {
    return { ok: false };
  }
  const pathMatch = COLLECTIBLE_REPACKS_PATH.exec(url.pathname);
  if (pathMatch === null) return { ok: false };
  const publicCollectibleId = publicCollectibleIdSchema.safeParse(pathMatch[1]);
  if (!publicCollectibleId.success) return { ok: false };
  const parsed = findRepacksByDesiredCollectibleInputSchema.safeParse({
    publicCollectibleId: publicCollectibleId.data,
    limit: PUBLIC_REPACK_MAX_PAGE_SIZE,
  });
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false };
}
