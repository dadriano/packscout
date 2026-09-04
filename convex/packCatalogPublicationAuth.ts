import {
  MAX_PACK_CATALOG_HTTP_BODY_BYTES,
  PACK_CATALOG_OPERATION_AUTHORITY,
  PACK_CATALOG_V1,
  assertPublicPackCatalogBytes,
  packCatalogCanonicalJson,
  packCatalogKeyAuthoritySha256,
  packCatalogPublicationRequestSchema,
  packCatalogRequestEntity,
  trustedPackCatalogServiceIdentityAllows,
  type PackCatalogEnvironment,
  type PackCatalogKeyAuthority,
  type PackCatalogPublicationOperationKind,
  type PackCatalogPublicationRequest,
} from "@packscout/contracts";
import { env } from "./_generated/server";
import { refusePackCatalog } from "./packCatalogErrors";
import { packCatalogPublicationKeyAuthority } from "./productionPublicationKeyConfig";

/**
 * Body-level authorization for the `pack_catalog_v1` store. The HTTP layer has
 * already proven the caller holds a configured signing key; this boundary
 * proves that key may perform exactly this operation on exactly this entity:
 * the deployment binds each key to one environment, organization, and scope,
 * the request carries a P01 trusted service identity, and the two must agree
 * on every field before any state is read.
 */

export type ExecutionArgs = Readonly<{
  bodyJson: string;
  requestDigest: string;
  authenticatedKeyId: string;
}>;

export interface AuthorizedPackCatalogRequest<
  K extends PackCatalogPublicationOperationKind,
> {
  readonly request: Extract<PackCatalogPublicationRequest, { operationKind: K }>;
  readonly authority: PackCatalogKeyAuthority;
  readonly keyId: string;
  readonly requestSha256: string;
  readonly authorizationScopeSha256: string;
  readonly now: string;
}

export function packCatalogRuntimeEnvironment(): PackCatalogEnvironment | null {
  switch (env.PACKSCOUT_RUNTIME_ENVIRONMENT) {
    case "local":
    case "development":
      return "local";
    case "preproduction":
      return "preproduction";
    case "production":
      return "live";
    default:
      return null;
  }
}

function parseRequest(bodyJson: string): PackCatalogPublicationRequest {
  if (new TextEncoder().encode(bodyJson).byteLength > MAX_PACK_CATALOG_HTTP_BODY_BYTES) {
    refusePackCatalog("PACK_CATALOG_BODY_TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson) as unknown;
  } catch {
    return refusePackCatalog("PACK_CATALOG_REQUEST_INVALID");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    refusePackCatalog("PACK_CATALOG_REQUEST_INVALID");
  }
  if ((raw as { schemaVersion?: unknown }).schemaVersion !== PACK_CATALOG_V1) {
    refusePackCatalog("PACK_CATALOG_SCHEMA_UNSUPPORTED");
  }
  try {
    assertPublicPackCatalogBytes((raw as { body?: unknown }).body ?? null);
  } catch (error) {
    refusePackCatalog(
      error instanceof TypeError && error.message.includes("protected field")
        ? "PACK_CATALOG_PROTECTED_FIELD"
        : "PACK_CATALOG_REQUEST_INVALID",
    );
  }
  const parsed = packCatalogPublicationRequestSchema.safeParse(raw);
  if (!parsed.success || packCatalogCanonicalJson(parsed.data) !== bodyJson) {
    refusePackCatalog("PACK_CATALOG_REQUEST_INVALID");
  }
  return parsed.data;
}

/** A provider-scoped key may act only on packs owned by its provider. */
export function assertProviderScope(
  authorized: { readonly authority: PackCatalogKeyAuthority },
  providerId: string | null | undefined,
): void {
  if (providerId !== null && providerId !== undefined &&
    authorized.authority.scope.scopeKind === "provider" &&
    authorized.authority.scope.providerId !== providerId) {
    refusePackCatalog("PACK_CATALOG_AUTH_FORBIDDEN");
  }
}

export async function authorizePackCatalogRequest<
  K extends PackCatalogPublicationOperationKind,
>(
  args: ExecutionArgs,
  kinds: readonly K[],
): Promise<AuthorizedPackCatalogRequest<K>> {
  if (!/^[0-9a-f]{64}$/u.test(args.requestDigest)) {
    refusePackCatalog("PACK_CATALOG_REQUEST_INVALID");
  }
  const request = parseRequest(args.bodyJson);
  if (!(kinds as readonly string[]).includes(request.operationKind)) {
    refusePackCatalog("PACK_CATALOG_REQUEST_INVALID");
  }
  const authority = packCatalogPublicationKeyAuthority(args.authenticatedKeyId);
  if (authority === null) refusePackCatalog("PACK_CATALOG_AUTH_KEY_UNKNOWN");
  const identity = request.serviceIdentity;
  const environment = packCatalogRuntimeEnvironment();
  const now = new Date().toISOString();
  if (
    environment === null ||
    identity.environment !== environment ||
    identity.environment !== authority.environment ||
    identity.organizationId !== authority.organizationId ||
    packCatalogCanonicalJson(identity.scope) !== packCatalogCanonicalJson(authority.scope) ||
    identity.authorizationSha256 !==
      await packCatalogKeyAuthoritySha256(args.authenticatedKeyId, authority) ||
    !trustedPackCatalogServiceIdentityAllows({
      identity,
      environment,
      organizationId: authority.organizationId,
      providerId: authority.scope.scopeKind === "provider" ? authority.scope.providerId : undefined,
      entity: packCatalogRequestEntity(request),
      operation: PACK_CATALOG_OPERATION_AUTHORITY[request.operationKind],
      now,
    })
  ) {
    refusePackCatalog("PACK_CATALOG_AUTH_FORBIDDEN");
  }
  return {
    request: request as Extract<PackCatalogPublicationRequest, { operationKind: K }>,
    authority,
    keyId: args.authenticatedKeyId,
    requestSha256: args.requestDigest,
    authorizationScopeSha256: identity.authorizationSha256,
    now,
  };
}
