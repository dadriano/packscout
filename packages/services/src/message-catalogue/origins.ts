/**
 * The message catalogue's single origin-configuration read. Every link in a
 * rendered message is absolute and built from one of two configured public
 * origins: the product origin for messages to product users and the admin
 * origin for messages to operators. Renderers never read the environment
 * themselves — a caller resolves origins once through
 * {@link resolveMessageCatalogueOrigins} and hands the result to every render
 * call, which keeps rendering pure and makes "no origin configured" an
 * explicit render failure instead of a relative or broken link.
 */

/** The product's public origin; the frontend already reads this variable. */
export const PRODUCT_PUBLIC_ORIGIN_VARIABLE = "PACKSCOUT_PUBLIC_ORIGIN";

/** The admin console's public origin; operator links are built from it. */
export const ADMIN_PUBLIC_ORIGIN_VARIABLE = "PACKSCOUT_ADMIN_PUBLIC_ORIGIN";

/** The validated link origins every render call receives. */
export interface MessageCatalogueOrigins {
  /** Origin for links into the product, or null when unconfigured. */
  readonly productOrigin: string | null;
  /** Origin for links into the admin, or null when unconfigured. */
  readonly adminOrigin: string | null;
}

/**
 * Validates one configured origin with the same rules the frontend applies to
 * PACKSCOUT_PUBLIC_ORIGIN: the value must be an origin and nothing else — no
 * path, query, fragment, or credentials — and must be HTTPS, except that
 * plain-HTTP localhost is allowed outside production. Anything else counts as
 * unconfigured rather than as an origin to build links from.
 */
export function validatedPublicMessageOrigin(
  value: string | undefined,
  nodeEnvironment: string | undefined,
): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    const localHttp =
      nodeEnvironment !== "production" &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (
      parsed.username ||
      parsed.password ||
      candidate !== parsed.origin ||
      (parsed.protocol !== "https:" && !localHttp)
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Resolves both catalogue origins from server-side configuration. This is the
 * catalogue's only environment read; renderers take the resolved value.
 */
export function resolveMessageCatalogueOrigins(
  env: NodeJS.ProcessEnv = process.env,
): MessageCatalogueOrigins {
  return {
    productOrigin: validatedPublicMessageOrigin(
      env[PRODUCT_PUBLIC_ORIGIN_VARIABLE],
      env.NODE_ENV,
    ),
    adminOrigin: validatedPublicMessageOrigin(
      env[ADMIN_PUBLIC_ORIGIN_VARIABLE],
      env.NODE_ENV,
    ),
  };
}
