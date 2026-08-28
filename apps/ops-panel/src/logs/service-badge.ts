/**
 * A colour per service, derived from its name.
 *
 * The panel discovers services from the filesystem, so it cannot hold a list of
 * known services and their colours — a new service would either be uncoloured
 * or would steal someone else's. Hashing the name instead means every service
 * has a colour on its first line, the colour is the same in every browser and
 * across restarts, and adding a service never re-colours the others.
 *
 * Hue is the only hashed channel. Saturation and lightness are fixed so
 * contrast stays predictable in both themes.
 */

/** FNV-1a: small, well-distributed for short names, and stable forever. */
function hashName(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Hues are picked from a ring of 24 stops rather than the full circle, so two
 * services are either clearly the same colour or clearly different, instead of
 * being separated by a few degrees nobody can see.
 */
export const SERVICE_HUE_STOPS = 24;

export function serviceBadgeHue(service: string): number {
  return (hashName(service) % SERVICE_HUE_STOPS) * (360 / SERVICE_HUE_STOPS);
}

/** Custom properties the stylesheet turns into badge and gutter colours. */
export function serviceBadgeVariables(
  service: string,
): Record<string, string> {
  return { "--panel-service-hue": `${serviceBadgeHue(service)}` };
}
