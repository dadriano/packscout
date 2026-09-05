import { assertPublicPackCatalogBytes } from "./pack-catalog-v1.ts";
import { normalizeProtectedPublicationFieldKey } from "./protected-publication-fields.ts";

const privateKeys = new Set(["account", "accountid", "authorization", "authorizationcode", "cookie", "setcookie", "codeverifier", "connectionstring", "connectionurl", "databaseurl",
  "databasetarget", "host", "port", "stack", "stacktrace", "instanceid", "exactinstance", "userid", "userdata",
  "rawsourceevidence", "sig", "xamzsignature", "signature"]);
// Bearer is ordinary public prose unless a protected field or authorization
// assignment establishes credential context; token spelling/length cannot do so.
const credentialText = /(?:postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis(?:s)?:\/\/|-----BEGIN (?:(?!-----)[^\r\n])*PRIVATE KEY(?: BLOCK)?-----|(?:api[_\s-]?key|password|secret|access[_\s-]?token|refresh[_\s-]?token|authorization)["']?\s*[:=]\s*\S+)/iu;
const privateUriScheme = /^(?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|sqlite|mongodb|rediss?|amqps?|nats|kafkas?|pulsar|mqtts?|cassandra|couchbases?|neo4j|bolt|memcached)(?:\+[a-z0-9.-]+)?$/iu;
function hasPrivateUriTarget(value: string, start: number): boolean {
  // A contiguous endpoint/path, userinfo, port, query, encoded URI or SQLite :memory: target
  // differs from "Bolt: Premium Edition" and "Bolt:Premium Edition" prose.
  // Constant-width lookahead stops at the first marker instead of scanning a suffix.
  for (let index = start; index < value.length && !/\s/u.test(value[index]!); index += 1) {
    if (/^[/\\@?#=:]|^%[0-9a-f]{2}|^[a-z0-9]\.[a-z0-9]/iu.test(value.slice(index, index + 3))) return true;
  }
  return false;
}
const oauthKeys = new Set(["clientid", "redirecturi", "responsetype", "granttype", "codechallenge", "codechallengemethod"]);
type OAuthContext = { authentication: boolean; code: boolean };
function hasCookiePair(text: string, start: number): boolean {
  // Header names alone are public prose; a name/value pair establishes context.
  // Sticky matching avoids copying or searching an unrelated suffix.
  const pair = /[!#$%&'*+.^_\x60|~a-z0-9-]+\s*=\s*\S/iyu;
  pair.lastIndex = start;
  return pair.test(text);
}
const reject = () => { throw new TypeError("PUBLIC_CATALOG_PROTECTED_TEXT"); };

/** Public strings must be safe after display/search normalization as well as before it. */
function assertPublicCatalogLexicalText(value: string): void {
  // Bound normalization and the linear embedded-authority scan independently of callers.
  if (value.length > 65_536) reject();
  const normalized = value.trim().normalize("NFKC");
  if (normalized.length > 65_536 || credentialText.test(normalized)) reject();
  // Basic credentials may be short. Canonical base64 with a user/password
  // separator distinguishes credentials from ordinary "Basic edition" prose.
  for (const match of normalized.matchAll(/\bBasic\s+([a-z0-9+/]+={0,2})/giu)) {
    let decoded: string;
    try { decoded = atob(match[1]!); } catch { continue; }
    if (btoa(decoded).replace(/=+$/u, "") === match[1]!.replace(/=+$/u, "") && decoded.includes(":")) reject();
  }
  // WHATWG removes TAB/LF/CR everywhere, including within userinfo. Ambiguous
  // control-joined URL/email text therefore fails closed; ordinary spaces remain.
  const recognized = normalized.replace(/[\t\n\r]/gu, "");
  // Consume complete scheme-like runs even when no colon follows. A required
  // trailing colon would repeatedly backtrack through long dotted public text.
  const schemes = /\b([a-z][a-z0-9+.-]*)(:)?([/\\]*)/giu;
  for (let match = schemes.exec(recognized); match !== null; match = schemes.exec(recognized)) {
    if (match[2] && privateUriScheme.test(match[1]!) &&
      hasPrivateUriTarget(recognized, schemes.lastIndex - match[3]!.length)) reject();
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
function isPrivateUrlHostname(value: string): boolean {
  // URL.hostname has already canonicalized numeric IPv4 spellings and IPv6.
  // Literal classification only: do not resolve DNS or infer private DNS names.
  const host = value.toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const privateIpv4 = (first: number, second: number) => first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) {
    const octets = host.split(".").map(Number); return privateIpv4(octets[0]!, octets[1]!);
  }
  if (!host.startsWith("[")) return false;
  const halves = host.slice(1, -1).split("::");
  const words = (part: string) => part === "" ? [] : part.split(":").map(word => Number.parseInt(word, 16));
  const leading = words(halves[0]!), trailing = words(halves[1] ?? "");
  const address = halves.length === 1 ? leading : [...leading, ...Array<number>(8 - leading.length - trailing.length).fill(0), ...trailing];
  if (address.slice(0, 6).every(word => word === 0) && address[6] === 0 && address[7]! <= 1) return true;
  if (address.slice(0, 5).every(word => word === 0) && address[5] === 0xffff) {
    return privateIpv4(address[6]! >> 8, address[6]! & 255);
  }
  return (address[0]! & 0xfe00) === 0xfc00 || (address[0]! & 0xffc0) === 0xfe80;
}
function originalUrlPath(candidate: string): string {
  // Retain path evidence that WHATWG removes when resolving dot segments.
  // Recognition rewrites only URL controls/slashes, never encoded separators.
  const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(candidate);
  let start = scheme?.[0].length ?? 0;
  if (candidate.startsWith("//", start)) {
    while (candidate[start] === "/") start += 1;
    while (start < candidate.length && !/[/?#]/u.test(candidate[start]!)) start += 1;
  }
  let end = start;
  while (end < candidate.length && !/[?#]/u.test(candidate[end]!)) end += 1;
  return candidate.slice(start, end);
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
  const inspectKey = (text: string, depth: number, context: OAuthContext, colonTarget?: boolean, cookieTarget = false, pathSegment = false): boolean => {
    const normalized = text.normalize("NFKC");
    const key = normalizeProtectedPublicationFieldKey(normalized);
    // A product path is not an HTTP header field; retain its traversal charge.
    if (pathSegment && (key === "cookie" || key === "setcookie")) { charge(text, depth); return false; }
    let protectedName = privateKeys.has(key);
    if (colonTarget !== undefined && !protectedName) {
      try { assertPublicPackCatalogBytes({ [normalized]: null }); } catch { protectedName = true; }
    }
    // Unquoted Actor is a public credit label. Host identifies topology only
    // when its value has connection syntax; quoted/URL/JSON fields stay strict.
    const cookieHeader = key === "cookie" || key === "setcookie";
    const publicLabel = colonTarget !== undefined && (key === "actor" || key === "host" || cookieHeader);
    if (publicLabel) protectedName = cookieHeader ? cookieTarget : key === "host" && colonTarget === true;
    // Ordinary unquoted labels are prose, not new traversal nodes. Encoded
    // candidate names still decode under the same charged depth/byte budget.
    if (colonTarget !== undefined && !protectedName && !text.includes("%")) return publicLabel;
    charge(text, depth);
    if (colonTarget === undefined || protectedName) {
      context.code ||= key === "code"; context.authentication ||= oauthKeys.has(key);
      if ((context.code && context.authentication) || privateKeys.has(key)) reject();
      assertPublicPackCatalogBytes({ [normalized]: null });
    }
    const decoded = decodeLayer(normalized);
    return decoded !== normalized ? inspectKey(decoded, depth + 1, context, colonTarget, cookieTarget, pathSegment) : publicLabel;
  };
  const inspectConnectionAssignments = (text: string, depth: number): void => {
    let through = -1, endpoint = false, catalog = false;
    // Context belongs only to adjacent semicolon fields, not unrelated prose.
    const fields = /(?:^|;)[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^=;\r\n]+))[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^;\r\n]*))[ \t]*/gmu;
    for (const match of text.matchAll(fields)) {
      if (match.index !== through) { endpoint = false; catalog = false; }
      through = match.index + match[0].length;
      const quoted = match[1] !== undefined || match[2] !== undefined;
      let name = match[1] ?? match[2] ?? match[3]!, keyDepth = depth + 1;
      while (name.includes("%")) {
        charge(name, keyDepth++);
        name = name.trim().normalize("NFKC");
        const decoded = decodeLayer(name);
        if (decoded === name) break;
        name = decoded;
      }
      name = name.normalize("NFKC");
      const names = [normalizeProtectedPublicationFieldKey(name.trim())];
      if (!quoted) {
        const trimmed = name.trim().replace(/\s+/gu, " "), last = trimmed.lastIndexOf(" ");
        names.push(normalizeProtectedPublicationFieldKey(trimmed.slice(last + 1)));
        if (last >= 0) names.push(normalizeProtectedPublicationFieldKey(trimmed.slice(trimmed.lastIndexOf(" ", last - 1) + 1)));
      }
      const server = names.includes("server"), source = names.includes("datasource");
      const database = names.includes("database") || names.includes("initialcatalog");
      if (!server && !source && !database) continue;
      charge(name, keyDepth);
      const rawTarget = (match[4] ?? match[5] ?? match[6]!).trim();
      let target = rawTarget, targetDepth = depth + 1;
      if (server || source) {
        // Decode only this assignment value until a public URL is recognizable;
        // encoded path/query boundaries remain the existing URL visitor's job.
        while (!/^https?:\/\//iu.test(target) && target.includes("%")) {
          charge(target, targetDepth++);
          target = target.trim().normalize("NFKC");
          const decoded = decodeLayer(target);
          if (decoded === target) break;
          target = decoded.trim();
        }
        const connection = hasPrivateUriTarget(target, 0) || /,[ \t]*[0-9]{1,5}$/u.test(target) || isPrivateUrlHostname(target);
        const publicSourceUrl = source && /^https?:\/\//iu.test(target);
        if (connection && !publicSourceUrl) reject();
        if (publicSourceUrl && target !== rawTarget) visit(target, targetDepth, false);
        // Explicit endpoint/catalog fields establish context without guessing
        // a hostname grammar for quoted, braced or named instances.
        endpoint ||= target !== "";
      }
      catalog ||= database && target !== "";
      if (endpoint && catalog) reject();
    }
  };
  const inspectProseAssignments = (text: string, depth: number): void => {
    inspectConnectionAssignments(text, depth);
    // Quotes establish the whole assigned name, including punctuation that the
    // protected-field normalizer removes. Each scan stops at its next delimiter.
    for (const match of text.matchAll(/"([^"]*)"\s*[:=]|'([^']*)'\s*[:=]/gu)) {
      inspectKey(match[1] ?? match[2]!, depth + 1, { authentication: false, code: false });
    }
    // Consume full runs even without '='; bounded suffixes recognize spaced or
    // quoted names without treating ordinary colon labels as structured fields.
    for (const match of text.matchAll(/[a-z0-9%_.-]+(?:[ \t]+[a-z0-9%_.-]+)*/giu)) {
      let end = match.index + match[0].length;
      if (text[end] === '"' || text[end] === "'") end += 1;
      while (end < text.length && /\s/u.test(text[end]!)) end += 1;
      const colon = text[end] === ":";
      if (text[end] !== "=" && !colon) continue;
      // A bare label can be public on its own; joined search text is scanned
      // again after aliases supply an actual value (e.g. "Authorization:").
      let valueStart = end + 1;
      while (colon && valueStart < text.length && /\s/u.test(text[valueStart]!)) valueStart += 1;
      if (colon && valueStart === text.length) continue;
      if (colon && /["']/u.test(text[valueStart]!)) {
        valueStart += 1;
        while (valueStart < text.length && /\s/u.test(text[valueStart]!)) valueStart += 1;
      }
      const colonTarget = colon ? hasPrivateUriTarget(text, valueStart) : undefined;
      const cookieTarget = colon && hasCookiePair(text, valueStart);
      const words = match[0].split(/\s+/u);
      let key = "";
      for (let index = words.length - 1; index >= 0; index -= 1) {
        // Preceding prose is not part of an assigned key. Quoted names, unlike
        // "Secret edition code=SUMMER", explicitly establish the whole name.
        if (index < words.length - 1 && !/["']/u.test(text[match.index - 1] ?? "")) {
          try { assertPublicPackCatalogBytes({ [words[index]!]: null }); } catch { break; }
        }
        key = words[index]! + (key === "" ? "" : ` ${key}`);
        if (key.length > 256) break;
        // URL/form parsing owns contextual OAuth codes; lexical assignment
        // discovery must not join separate URLs into one authentication context.
        const publicLabel = inspectKey(key, depth + 1, { authentication: false, code: false }, colonTarget, cookieTarget);
        // A recognized public credit/host label ends the name; preceding prose
        // must not manufacture a different protected field.
        if (publicLabel) break;
      }
    }
  };
  const authenticationRoute = (path: string, depth: number): boolean => {
    if (/(?:^|\/)(?:oauth2?|oidc|auth|authorize|authorization|callback|login|signin|sign-in|signin-oidc|sso)(?:[-_]callback)?(?:\/|$|[.;])/iu.test(path.replaceAll("\\", "/"))) return true;
    const decoded = decodeLayer(path);
    if (decoded === path) return false;
    charge(decoded, depth + 1);
    return authenticationRoute(decoded, depth + 1);
  };
  const inspectPath = (path: string, depth: number, context: OAuthContext): void => {
    // Iterate nonempty runs without allocating a slash-sized array. WHATWG
    // path-separator recognition also applies after bounded component decoding.
    const normalized = path.replaceAll("\\", "/");
    for (const match of normalized.matchAll(/[^/]+/gu)) {
      let next = match.index + match[0].length;
      while (normalized[next] === "/") next += 1;
      if (next < normalized.length) inspectKey(match[0], depth + 1, context, undefined, false, true);
    }
    // Decode only the pathname component, preserving the URL's authority/query
    // boundaries while exposing encoded path-name/value separators.
    const decoded = decodeLayer(normalized);
    if (decoded !== normalized) { charge(decoded, depth + 1); inspectPath(decoded, depth + 1, context); }
  };
  const stringTokenEnd = (text: string, start: number): number => {
    let index = start + 1;
    while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
    return index < text.length ? index + 1 : text.length + 1;
  };
  const arrayScalarPrefix = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)\s*(?=[,\]]|$)/iyu;
  const isProseContainer = (text: string, start: number): boolean => {
    let next = start + 1;
    while (next < text.length && /\s/u.test(text[next]!)) next += 1;
    const object = text[start] === "{";
    if (text[next] === (object ? "}" : "]")) return true;
    if (text[next] === '"') {
      next = stringTokenEnd(text, next);
      while (next < text.length && /\s/u.test(text[next]!)) next += 1;
      return object ? text[next] === ":" : text[next] === "," || text[next] === "]";
    }
    if (object) return false;
    if (text[next] === "{" || text[next] === "[") return true;
    // Scan a scalar sequence forward before classifying it as JSON: the first
    // comma in [1,000 cards] is not enough. The charged parser remains strict.
    let separator = false;
    while (next < text.length) {
      arrayScalarPrefix.lastIndex = next;
      if (!arrayScalarPrefix.test(text)) return false;
      next = arrayScalarPrefix.lastIndex;
      if (next === text.length) return separator;
      if (text[next] === "]") return true;
      separator = true;
      next += 1;
      while (next < text.length && /\s/u.test(text[next]!)) next += 1;
      if (next === text.length || /[\]"{[]/u.test(text[next]!)) return true;
    }
    return false;
  };
  const inspectLeadingStructuredText = (text: string, depth: number, context: OAuthContext): boolean => {
    const candidate = text.trim();
    // Natural labels such as [1/1], {Limited Edition}, or a quoted name followed
    // by prose do not establish a whole JSON document, including inside captions.
    if ((candidate[0] === "{" || candidate[0] === "[") && isProseContainer(candidate, 0)) {
      inspectStructuredText(candidate, depth, context); return true;
    }
    return candidate[0] === '"' && stringTokenEnd(candidate, 0) === candidate.length &&
      inspectStructuredText(candidate, depth, context, 0, true) > 0;
  };
  const inspectStructuredText = (text: string, depth: number, context: OAuthContext, prefixStart?: number, proseString = false): number => {
    // Inspect tokens before parsing the document so overwritten duplicate keys
    // cannot erase protected evidence. Use the same bounds as URL/form traversal.
    let nesting = 0, index = prefixStart ?? 0;
    while (index < text.length) {
      const start = index, character = text[index++]!;
      if (/\s|[,:]/u.test(character)) continue;
      if (character === "{" || character === "[") {
        nesting += 1; charge(character, depth + nesting); continue;
      }
      if (character === "}" || character === "]") {
        if (nesting <= 0) reject(); nesting -= 1;
        if (prefixStart !== undefined && nesting === 0) break;
        continue;
      }
      if (character === '"') {
        index = stringTokenEnd(text, start);
        if (proseString && index > text.length) return -index;
        if (index > text.length) reject();
        let decoded: string;
        try { decoded = JSON.parse(text.slice(start, index)) as string; }
        catch { if (proseString) return -index; return reject(); }
        let next = index;
        while (next < text.length && /\s/u.test(text[next]!)) next += 1;
        if (text[next] === ":") inspectKey(decoded, depth + nesting + 1, context);
        else visit(decoded, depth + nesting + 1, false, context);
        if (prefixStart !== undefined && nesting === 0) break;
      } else {
        while (index < text.length && !/[\s{}[\]",:]/u.test(text[index]!)) index += 1;
        charge(text.slice(start, index), depth + nesting + 1);
      }
    }
    if (nesting !== 0) reject();
    try { JSON.parse(prefixStart === undefined ? text : text.slice(prefixStart, index)); } catch { reject(); }
    return index;
  };
  const inspectProseStructuredText = (text: string, depth: number, context?: OAuthContext, charged = false): void => {
    // Absolute offsets consume complete roots, not repeatedly parsed suffixes.
    // Natural brace/bracket labels and malformed prose quotes remain text.
    // The closing prose quote can also begin an explicit escaped JSON key.
    let quoteThrough = -1;
    for (let index = 0; index < text.length; index += 1) {
      const container = (text[index] === "{" || text[index] === "[") && isProseContainer(text, index);
      let quoted = false;
      if (!container && text[index] === '"' && index >= quoteThrough) {
        const end = stringTokenEnd(text, index);
        quoteThrough = end - 1;
        quoted = text.slice(index, end).includes("\\");
      }
      if (!container && !quoted) continue;
      if (!charged) { charge(text, depth); charged = true; }
      const end = inspectStructuredText(text, depth, context ?? { authentication: false, code: false }, index, quoted);
      if (end > 0) index = end - (quoted ? 2 : 1);
    }
  };
  const inspectFragment = (text: string, depth: number, context: OAuthContext): void => {
    charge(text, depth);
    inspectProseAssignments(text, depth);
    // Padding contains no named field or data beyond separators. Do not turn
    // each '=' into another form layer; all non-padding payloads still traverse.
    if (/^=+$/u.test(text)) return;
    if (inspectLeadingStructuredText(text, depth, context)) return;
    const isTarget = (value: string) => {
      const candidate = urlRecognition(value), query = candidate.indexOf("?"), assignment = candidate.indexOf("=");
      return /^[a-z][a-z0-9+.-]*:|^[/?]|^\.{1,2}\//iu.test(candidate) ||
        (query >= 0 && (assignment < 0 || query < assignment));
    };
    if (isTarget(text)) { visit(text, depth + 1, false, context); return; }
    const decoded = decodeLayer(text);
    if (decoded !== text && (isTarget(decoded) || !text.includes("="))) {
      inspectFragment(decoded, depth + 1, context); return;
    }
    inspectProseStructuredText(text, depth, context, true);
    inspectEmbedded(text, depth + 1);
    // A fragment is either one bare target or a form, never both.
    for (const [key, nested] of new URLSearchParams(text)) {
      inspectKey(key, depth + 1, context); visit(nested, depth + 1, false, context);
    }
  };
  const visit = (text: string, depth: number, required = false, context: OAuthContext = { authentication: false, code: false }): void => {
    charge(text, depth);
    if (!required) inspectProseAssignments(text.normalize("NFKC"), depth);
    if (!required && inspectLeadingStructuredText(text, depth, context)) return;
    if (!required) inspectProseStructuredText(text, depth, context, true);
    const candidate = urlRecognition(text);
    // Nested prose can contain another URL. Share this traversal's budget rather
    // than recursively invoking an exported validator with fresh counters.
    inspectEmbedded(text, depth + 1, true);
    const assignment = candidate.indexOf("="), marker = candidate.search(/[?#]/u);
    if (!required && assignment >= 0 && (marker < 0 || assignment < marker) &&
      !/^[a-z][a-z0-9+.-]*:|^[/?]|^\.{1,2}\//iu.test(candidate)) {
      inspectFragment(text, depth + 1, context); return;
    }
    if (!required && !candidate.startsWith("/") && !/^[a-z][a-z0-9+.-]*:|[?#]/iu.test(candidate)) {
      if (candidate.includes("=")) { inspectFragment(text, depth + 1, context); return; }
      const decoded = decodeLayer(text);
      if (decoded !== text) visit(decoded, depth + 1, false, context);
      return;
    }
    const labelScheme = required ? null : /^([a-z][a-z0-9+.-]*):/iu.exec(candidate);
    const labelName = labelScheme?.[1]?.toLowerCase();
    const knownSchemeProse = labelScheme !== null && (labelName === "actor" ||
      ((labelName === "host" || privateUriScheme.test(labelScheme[1]!)) &&
        !hasPrivateUriTarget(candidate, labelScheme[0].length)));
    let url: URL;
    const absoluteScheme = /^[a-z][a-z0-9+.-]*:/iu.test(candidate);
    try { url = new URL(text, !absoluteScheme && (!required || candidate.startsWith("//")) ? "https://public.invalid" : undefined); } catch { return reject(); }
    if (url.username || url.password || isPrivateUrlHostname(url.hostname) ||
      (!knownSchemeProse && !["https:", "http:"].includes(url.protocol))) reject();
    // Optional scheme/credit labels are prose, but still traverse every attached
    // query/fragment value below. Required URL fields remain strictly HTTP(S).
    const originalPath = knownSchemeProse ? url.pathname : originalUrlPath(candidate);
    const urlContext = { authentication: authenticationRoute(url.pathname, depth) ||
      (originalPath !== url.pathname && authenticationRoute(originalPath, depth)) ||
      (/^[?#]/u.test(candidate) && context.authentication), code: false };
    if (!knownSchemeProse) {
      inspectPath(originalPath, depth, urlContext);
      if (originalPath !== url.pathname) inspectPath(url.pathname, depth, urlContext);
    }
    // Once structural, decode individual names/values, never the entire URL.
    for (const [key, nested] of url.searchParams) {
      inspectKey(key, depth + 1, urlContext); visit(nested, depth + 1, false, urlContext);
    }
    if (url.hash !== "") inspectFragment(url.hash.slice(1), depth + 1, urlContext);
    // URL parsing removes raw TAB/LF/CR before returning query/hash values.
    // Preserve original component evidence without decoding URL delimiters.
    const componentSource = text.trim(), hash = componentSource.indexOf("#"), query = componentSource.indexOf("?");
    const originalQuery = query >= 0 && (hash < 0 || query < hash)
      ? componentSource.slice(query + 1, hash < 0 ? undefined : hash) : "";
    if (originalQuery !== url.search.slice(1)) {
      for (const [key, nested] of new URLSearchParams(originalQuery)) {
        inspectKey(key, depth + 1, urlContext); visit(nested, depth + 1, false, urlContext);
      }
    }
    const originalFragment = hash < 0 ? "" : componentSource.slice(hash + 1);
    if (originalFragment !== url.hash.slice(1)) inspectFragment(originalFragment, depth + 1, urlContext);
  };
  const inspectEmbedded = (text: string, depth: number, skipLeading = false): void => {
    const normalized = text.trim().normalize("NFKC");
    const inspectTarget = (value: string): void => {
      // Prose delimiters are not part of a bare URL; userinfo has already been
      // checked without removing punctuation from the complete authority.
      // An IPv6 authority's closing bracket is URL structure, not prose.
      const authorityEnd = /^(?:[a-z][a-z0-9+.\-\t\n\r]*:)?[/\\\t\n\r]*\[[^\]]+\]/iu.exec(value)?.[0].length ?? 0;
      // A closing JSON array/object delimiter in a query or fragment is data,
      // not an enclosing prose mark. Keep it for strict component inspection.
      const punctuation = /[?#]/u.test(value) ? /["'<>().,;]+$/gu : /["'<>()[\]{},.;]+$/gu;
      const trimmedLength = value.replace(punctuation, "").length;
      const target = value.slice(0, Math.max(authorityEnd, trimmedLength));
      visit(target, depth, true);
    };
    // Preserve URL-internal controls for original query/fragment inspection,
    // including controls WHATWG ignores inside the HTTP scheme itself.
    for (const match of normalized.matchAll(/\bh[\t\n\r]*t[\t\n\r]*t[\t\n\r]*p[\t\n\r]*s?[\t\n\r]*:(?:[^\s]|[\t\n\r])*/giu)) {
      if (!(skipLeading && match.index === 0)) inspectTarget(match[0]);
    }
    // Keep original control-separated prose boundaries; consume complete
    // absolute tokens so path emails are not rediscovered as authorities.
    // A delimiter-only split name such as Fire // Ice has no URL target.
    for (const match of normalized.matchAll(/[a-z][a-z0-9+.\-\t\n\r]*(?::(?:[^\s<>"']|[\t\n\r])*)?|(?<![\w:/\\])[/\\][\t\n\r]*[/\\](?:[^\s<>"']|[\t\n\r])*/giu)) {
      if (/^[/\\]/u.test(match[0]) && !(skipLeading && match.index === 0)) {
        // Quotes delimit prose tokens, but WHATWG permits them inside userinfo.
        // Inspect the complete raw authority before shortening the token.
        let authority = match.index;
        while (/[/\\\t\n\r]/u.test(normalized[authority] ?? "")) authority += 1;
        while (authority < normalized.length && (!/[/\\?#\s]/u.test(normalized[authority]!) || /[\t\n\r]/u.test(normalized[authority]!))) {
          if (normalized[authority] === "@") reject();
          authority += 1;
        }
        if (/[^/\\\t\n\r]/u.test(match[0])) inspectTarget(match[0]);
      }
    }
  };
  if (required) visit(value, 0, true);
  else {
    const normalized = value.trim().normalize("NFKC");
    inspectProseStructuredText(normalized, 0);
    inspectProseAssignments(normalized, 0);
    inspectEmbedded(value, 0);
  }
}

export function assertPublicCatalogText(value: string): void {
  assertPublicCatalogLexicalText(value);
  inspectPublicCatalogUrls(value, false);
}

export function assertPublicCatalogUrl(value: string): void {
  inspectPublicCatalogUrls(value, true);
}
