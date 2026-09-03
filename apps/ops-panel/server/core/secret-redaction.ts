/**
 * A last line of defence over text the panel did not write.
 *
 * Driver and tooling messages sometimes quote the connection string back — with
 * its user info attached. Every such message passes through here before it can
 * reach a response, a client, or the panel's own log, so a credential cannot
 * escape by way of an error string the panel merely relayed.
 *
 * This is defence in depth, not the primary control: the panel never puts a
 * secret in a response or an argument list in the first place.
 */

export const REDACTED = "[redacted]";

const URL_USER_INFO = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]*(?::[^\s/@]*)?@/giu;
const KEY_VALUE_SECRET = /\b(password|passfile|sslpassword)\s*=\s*[^\s&;]+/giu;

/**
 * Remove known secrets and anything shaped like a credential from `text`.
 * Returns an empty string for anything that is not a non-empty string, so a
 * caller can never turn an odd value into an accidental disclosure.
 */
export function redactSecrets(
  text: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  if (typeof text !== "string" || text.length === 0) return "";
  let redacted = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.trim().length === 0) continue;
    redacted = redacted.replaceAll(secret, REDACTED);
    redacted = redacted.replaceAll(secret.trim(), REDACTED);
  }
  redacted = redacted.replace(URL_USER_INFO, `$1://${REDACTED}@`);
  redacted = redacted.replace(KEY_VALUE_SECRET, (match) => {
    const name = match.split("=", 1)[0] ?? "password";
    return `${name}=${REDACTED}`;
  });
  return redacted;
}

/** Describe an unknown thrown value in one redacted line. */
export function describeRedactedError(
  error: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message, secrets);
  return redacted.length === 0 ? "No further detail is available." : redacted;
}
