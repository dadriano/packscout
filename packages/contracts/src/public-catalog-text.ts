import { assertPublicPackCatalogBytes } from "./pack-catalog-v1.ts";
import { normalizeProtectedPublicationFieldKey } from "./protected-publication-fields.ts";

const privateKeys = new Set(["account", "accountid", "authorization", "authorizationcode", "connectionstring", "connectionurl", "databaseurl",
  "databasetarget", "host", "port", "stack", "stacktrace", "instanceid", "exactinstance", "userid", "userdata",
  "rawsourceevidence", "sig", "xamzsignature", "signature"]);
const credentialText = /(?:postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis(?:s)?:\/\/|-----BEGIN .*PRIVATE KEY-----|\b(?:bearer|basic)\s+[a-z0-9+/_=.~-]{20,}|(?:api[_\s-]?key|password|secret|access[_\s-]?token|refresh[_\s-]?token|authorization)\s*[:=]\s*\S+)/iu;
const reject = () => { throw new TypeError("PUBLIC_CATALOG_PROTECTED_TEXT"); };

/** Public strings must be safe after display/search normalization as well as before it. */
function assertPublicCatalogLexicalText(value: string): void {
  // Bound normalization and the linear embedded-authority scan independently of callers.
  if (value.length > 65_536) reject();
  const normalized = value.trim().normalize("NFKC");
  if (normalized.length > 65_536 || credentialText.test(normalized)) reject();
  // WHATWG removes TAB/LF/CR everywhere, including within userinfo. Ambiguous
  // control-joined URL/email text therefore fails closed; ordinary spaces remain.
  const recognized = normalized.replace(/[\t\n\r]/gu, "");
  // Consume complete scheme-like runs even when no colon follows. A required
  // trailing colon would repeatedly backtrack through long dotted public text.
  const schemes = /\b([a-z][a-z0-9+.-]*)(:)?([/\\]*)/giu;
  for (let match = schemes.exec(recognized); match !== null; match = schemes.exec(recognized)) {
    if (!match[2] || (!/^(?:https?|ftp|wss?)$/iu.test(match[1]!) && match[3]!.length < 2)) continue;
    let end = schemes.lastIndex;
    while (end < recognized.length && !/[/\\?#\s]/u.test(recognized[end]!)) {
      if (recognized[end] === "@") reject();
      end++;
    }
    schemes.lastIndex = end;
  }
}

/** Recognize what WHATWG will parse without rewriting the URL's parameter structure. */
function urlRecognition(value: string): string {
  let start = 0, end = value.length;
  while (start < end && value.charCodeAt(start) <= 32) start++;
  while (end > start && value.charCodeAt(end - 1) <= 32) end--;
  return value.slice(start, end).replace(/[\t\n\r]/gu, "").replaceAll("\\", "/");
}
/** Query and fragment keys are decoded before checking the same protected-field policy. */
function inspectPublicCatalogUrls(value: string, required: boolean): void {
  let bytes = 0, nodes = 0;
  const encoder = new TextEncoder();
  // Decode one component layer, preserving literal separators and plus signs.
  const decodeLayer = (text: string) => new URLSearchParams(
    `value=${text.replaceAll("&", "%26").replaceAll("+", "%2B")}`,
  ).get("value")!;
  const charge = (text: string, depth: number): void => {
    if (depth > 6 || ++nodes > 1_000 || text.length > 32_768 || (bytes += encoder.encode(text).length) > 65_536) reject();
    assertPublicCatalogLexicalText(text);
  };
  const inspectKey = (text: string, depth: number): void => {
    charge(text, depth);
    const normalized = text.normalize("NFKC");
    if (privateKeys.has(normalizeProtectedPublicationFieldKey(normalized))) reject();
    assertPublicPackCatalogBytes({ [normalized]: null });
    const decoded = decodeLayer(normalized);
    if (decoded !== normalized) inspectKey(decoded, depth + 1);
  };
  const inspectFragment = (text: string, depth: number): void => {
    charge(text, depth);
    const isTarget = (value: string) => {
      const candidate = urlRecognition(value), query = candidate.indexOf("?"), assignment = candidate.indexOf("=");
      return /^[a-z][a-z0-9+.-]*:|^[/?]|^\.{1,2}\//iu.test(candidate) ||
        (query >= 0 && (assignment < 0 || query < assignment));
    };
    if (isTarget(text)) { visit(text, depth + 1); return; }
    const decoded = decodeLayer(text);
    if (decoded !== text && (isTarget(decoded) || !text.includes("="))) {
      inspectFragment(decoded, depth + 1); return;
    }
    // A fragment is either one bare target or a form, never both.
    for (const [key, nested] of new URLSearchParams(text)) {
      inspectKey(key, depth + 1); visit(nested, depth + 1);
    }
  };
  const visit = (text: string, depth: number, required = false): void => {
    charge(text, depth);
    const candidate = urlRecognition(text);
    // Nested prose can contain another URL. Share this traversal's budget rather
    // than recursively invoking an exported validator with fresh counters.
    inspectEmbedded(text, depth + 1, true);
    const assignment = candidate.indexOf("="), marker = candidate.search(/[?#]/u);
    if (!required && assignment >= 0 && (marker < 0 || assignment < marker) &&
      !/^[a-z][a-z0-9+.-]*:|^[/?]|^\.{1,2}\//iu.test(candidate)) {
      inspectFragment(text, depth + 1); return;
    }
    if (!required && !candidate.startsWith("/") && !/^[a-z][a-z0-9+.-]*:|[?#]/iu.test(candidate)) {
      if (candidate.includes("=")) { inspectFragment(text, depth + 1); return; }
      const decoded = decodeLayer(text);
      if (decoded !== text) visit(decoded, depth + 1);
      return;
    }
    let url: URL;
    try { url = new URL(text, !required || candidate.startsWith("//") ? "https://public.invalid" : undefined); } catch { return reject(); }
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) reject();
    // Once structural, decode individual names/values, never the entire URL.
    for (const [key, nested] of url.searchParams) {
      inspectKey(key, depth + 1); visit(nested, depth + 1);
    }
    if (url.hash !== "") inspectFragment(url.hash.slice(1), depth + 1);
  };
  const inspectEmbedded = (text: string, depth: number, skipLeading = false): void => {
    const recognized = text.trim().normalize("NFKC").replace(/[\t\n\r]/gu, "");
    for (const match of recognized.matchAll(/\bhttps?:[^\s]*/giu)) {
      if (skipLeading && match.index === 0) continue;
      // Prose delimiters are not part of a bare URL; userinfo has already been
      // checked without removing punctuation from the complete authority.
      const target = match[0].replace(/["'<>()[\]{},.;]+$/gu, "");
      visit(target, depth, true);
    }
  };
  if (required) visit(value, 0, true);
  else inspectEmbedded(value, 0);
}

export function assertPublicCatalogText(value: string): void {
  assertPublicCatalogLexicalText(value);
  inspectPublicCatalogUrls(value, false);
}

export function assertPublicCatalogUrl(value: string): void {
  inspectPublicCatalogUrls(value, true);
}
