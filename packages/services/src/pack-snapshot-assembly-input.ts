import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";
import { assertPublicPackCatalogBytes, compareCanonicalStrings, packBuildRequestSchema, packCatalogCanonicalByteCount,
  packSnapshotEvidenceSchema, providerPackBuildInputsSchema, publicProfileSnapshotIdSchema } from "@packscout/contracts";
import { packSnapshotAssemblyLimits as limits, requireAssembly } from "./pack-snapshot-assembly-types.ts";

const privateKeys = new Set(["account", "accountid", "authorization", "authorizationcode", "cookie", "setcookie", "codeverifier", "connectionstring", "connectionurl",
  "databaseurl", "databasetarget", "host", "port", "stack", "stacktrace", "instanceid", "exactinstance",
  "userid", "userdata", "rawsourceevidence", "sig", "xamzsignature", "signature", "pwd",
  "sessionid", "sessiontoken", "jsessionid", "phpsessid", "aspnetsessionid"]);
const credentialText = /(?:postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/|redis(?:s)?:\/\/|-----BEGIN (?:(?!-----)[^\r\n])*PRIVATE KEY(?: BLOCK)?-----|(?:api[_\s-]?key|password|secret|access[_\s-]?token|refresh[_\s-]?token|authorization)["']?\s*[:=]\s*\S+)/iu;
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
function isPrivateUrlHostname(value: string): boolean {
  // URL.hostname has canonicalized numeric IPv4 spellings and IPv6. Classify
  // only literal addresses/localhost; never resolve or infer private DNS names.
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
  // Keep path evidence erased by WHATWG dot-segment resolution. The candidate
  // normalizes URL controls/slashes only, not encoded component separators.
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
const oauthKeys = new Set(["clientid", "redirecturi", "responsetype", "granttype", "codechallenge", "codechallengemethod"]);
type OAuthContext = { authentication: boolean; code: boolean };
function hasCookiePair(text: string, start: number): boolean {
  // A cookie header needs a name/value pair; its name alone can be public prose.
  // Sticky matching inspects only this value, without allocating a suffix.
  const pair = /[!#$%&'*+.^_\x60|~a-z0-9-]+\s*=\s*\S/iyu;
  pair.lastIndex = start;
  return pair.test(text);
}
function isStackSource(source: string): boolean {
  if (/[\\/]/u.test(source) || /^<[^<>\r\n]+>$/u.test(source)) return true;
  // Test exclusions once before locating an interior dot. A greedy filename
  // regex would retry every dot when a long captured source ends in :bad.
  if (/[:\s]/u.test(source)) return false;
  const dot = source.indexOf(".", 1);
  return dot !== -1 && dot < source.length - 1;
}
function hasLiteralStackFrame(value: string): boolean {
  const text = value.normalize("NFKC");
  // A source location with line/column coordinates establishes a stack frame,
  // not the words Error/at alone. Fixed-shape function tokens and delimited
  // source spans keep the scan linear, including whitespace-collapsed search.
  for (const frame of text.matchAll(/(?:^|\s)at[ \t]+(?:(?:async|new)[ \t]+)?(?:[^\s()]+(?:[ \t]+\[as[ \t]+[^\]\r\n[]+\])?[ \t]+\(([^()\r\n]+):[0-9]+:[0-9]+\)|([^()\s]+):[0-9]+:[0-9]+)(?=$|[\s),.;])/giu)) {
    const source = frame[1] ?? frame[2]!;
    if (source.startsWith("node:") || isStackSource(source)) return true;
  }
  // Python frames quote a source file; Java frames name a class method and
  // .java source line; Firefox frames separate a function and absolute source
  // URL with @. None treats an ordinary Error label or email as a stack frame.
  for (const frame of text.matchAll(/(?:^|\s)File[ \t]+"([^"\r\n]+)",[ \t]+line[ \t]+[0-9]+(?=$|[\s,.;])/giu)) {
    if (isStackSource(frame[1]!)) return true;
  }
  // .NET source frames pair a method argument list with an explicit source line.
  for (const frame of text.matchAll(/(?:^|\s)at[ \t]+[^\s()]+\([^()\r\n]*\)[ \t]+in[ \t]+([^()\r\n]+):line[ \t]+[0-9]+(?=$|[\s),.;])/giu)) {
    if (isStackSource(frame[1]!)) return true;
  }
  // Ruby source/in-method frames, Go source/offset call pairs, and PHP numbered
  // source/call frames require their complete language-specific context.
  for (const frame of text.matchAll(/(?:^|\s)(?:from[ \t]+)?([^\s]+):[0-9]+:in[ \t]+`[^`'\r\n]+'(?=$|[\s),.;])/giu)) {
    if (isStackSource(frame[1]!)) return true;
  }
  for (const frame of text.matchAll(/(?:^|\s)[^\s()]+(?:\(\*[^\s()]+\)[^\s()]+)?\([^()\r\n]*\)\s+([^\s]+):[0-9]+[ \t]+\+0x[0-9a-f]+(?=$|[\s),.;])/giu)) {
    if (isStackSource(frame[1]!)) return true;
  }
  for (const frame of text.matchAll(/(?:^|\s)#[0-9]+[ \t]+([^\s()]+)\([0-9]+\):[ \t]+[^\s()]+\([^()\r\n]*\)(?=$|[\s),.;])/giu)) {
    if (isStackSource(frame[1]!)) return true;
  }
  return /(?:^|\s)at[ \t]+[a-z_$][\w$./<>]*\.[\w$<>]+\([^()\r\n]+\.java:[0-9]+\)(?=$|[\s),.;])/iu.test(text) ||
    /(?:^|\s)[^\s@()]*@(?:[a-z][a-z0-9+.-]*:\/{2,}|\/)[^\s()]+:[0-9]+:[0-9]+(?=$|[\s),.;])/iu.test(text);
}
function rejectCredentialText(value: string, inspectEmbeddedUrl?: (target: string) => void): void {
  const normalized = value.trim().normalize("NFC");
  requireAssembly(!credentialText.test(normalized) && !hasLiteralStackFrame(normalized));
  // Basic has no minimum credential length. Decode only canonical base64 with
  // its required user/password separator, preserving ordinary "Basic edition" prose.
  for (const match of normalized.matchAll(/\bBasic\s+([a-z0-9+/]+={0,2})/giu)) {
    const decoded = Buffer.from(match[1]!, "base64");
    requireAssembly(decoded.toString("base64").replace(/=+$/u, "") !== match[1]!.replace(/=+$/u, "") || !decoded.includes(58));
  }
  // URI authority ends at path/query/fragment or whitespace, not at a quote
  // that WHATWG would percent-encode inside a username or password.
  // WHATWG removes these controls even inside userinfo. Ambiguous control-joined
  // URL/email text therefore fails closed; ordinary prose spaces stay boundaries.
  const recognized = normalized.replaceAll("\t", "").replaceAll("\n", "").replaceAll("\r", "");
  // Consume whole scheme-like runs even when no URI follows. Remember scanned
  // spans so nested scheme spellings cannot rescan a long authority or suffix.
  const schemes = /[a-z][a-z0-9+.-]*/giu;
  let match: RegExpExecArray | null, authorityThrough = 0;
  while ((match = schemes.exec(recognized)) !== null) {
    const colon = schemes.lastIndex;
    if (recognized[colon] !== ":") continue;
    // Known scheme names alone are also product/book labels. Require connection
    // structure, including single-slash paths and opaque endpoint forms.
    requireAssembly(!privateUriScheme.test(match[0]) || !hasPrivateUriTarget(recognized, colon + 1));
    let authorityStart = colon + 1;
    while (recognized[authorityStart] === "/" || recognized[authorityStart] === "\\") authorityStart += 1;
    if (!/^(?:https?|ftp|wss?)$/iu.test(match[0]) && authorityStart - colon - 1 < 2) continue;
    let end = Math.max(authorityStart, authorityThrough);
    while (end < recognized.length && !/[\\/\s?#]/u.test(recognized[end]!)) {
      requireAssembly(recognized[end] !== "@"); end += 1;
    }
    authorityThrough = end;
  }
  if (inspectEmbeddedUrl) {
    // Retain original control-separated prose boundaries. Complete absolute
    // tokens still consume WHATWG-ignored controls, so a path email cannot
    // become another authority. Optional colons consume unmatched word runs.
    for (const target of normalized.matchAll(/[a-z][a-z0-9+.\-\t\n\r]*(?::(?:[^\s<>"']|[\t\n\r])*)?|(?<![\w:/\\])[/\\][\t\n\r]*[/\\](?:[^\s<>"']|[\t\n\r])*/giu)) {
      if (/^[/\\]/u.test(target[0])) {
        // Quotes/angles delimit prose tokens, but WHATWG accepts them inside
        // userinfo. Inspect the complete original authority before truncation.
        let end = target.index;
        while (/[/\\\t\n\r]/u.test(normalized[end] ?? "")) end += 1;
        while (end < normalized.length && !/[/?#\\]|[^\S\t\n\r]/u.test(normalized[end]!)) {
          requireAssembly(normalized[end] !== "@"); end += 1;
        }
        if (/[^/\\\t\n\r]/u.test(target[0])) inspectEmbeddedUrl(target[0]);
      } else {
        const candidate = target[0].replace(/[\t\n\r]/gu, "");
        if (/^(?:(?:https?|ftp|wss?):|[a-z][a-z0-9+.-]*:[/\\]{2})/iu.test(candidate)) inspectEmbeddedUrl(target[0]);
      }
    }
  }
}

/** Inspect descriptors before cloning so getters, cycles and mutable handles cannot
 * execute during capture. Unknown schema fields are rejected, never stripped. */
export function assertPackAssemblyPublicData(value: unknown): void {
  let nodes = 0, bytes = 0, urlNodes = 0, urlBytes = 0;
  const ancestors = new Set<object>(), keys = new Set<string>();
  const encoder = new TextEncoder();
  const decodeLayer = (text: string) => new URLSearchParams(
    `value=${text.replace(/&/gu, "%26").split("+").join("%2B")}`,
  ).get("value")!;
  function chargeUrlText(text: string, depth: number, stackRecognitionOnly = false): string {
    requireAssembly(++urlNodes <= limits.maximumNodes && depth <= limits.maximumDepth);
    urlBytes += encoder.encode(text).byteLength;
    requireAssembly(urlBytes <= limits.maximumInputBytes);
    if (stackRecognitionOnly) requireAssembly(!hasLiteralStackFrame(text));
    else rejectCredentialText(text);
    return text.trim().normalize("NFC");
  }
  function inspectUrlKey(text: string, depth: number, context: OAuthContext, colonTarget?: boolean, cookieTarget = false, pathTarget?: string): boolean {
    const key = text.trim().normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
    // Cookie product paths are not HTTP header fields; still charge their bytes.
    if (pathTarget !== undefined && (key === "cookie" || key === "setcookie")) { chargeUrlText(text, depth); return false; }
    if (pathTarget !== undefined && (key === "account" || key === "host")) {
      let target = pathTarget, targetDepth = depth;
      while (target.includes("%")) {
        const decoded = decodeLayer(chargeUrlText(target, targetDepth++));
        if (decoded === target) break;
        target = decoded.trim();
      }
      // Encoded separators can expose another path segment, not a value suffix.
      target = /[^/\\]+/u.exec(target)?.[0] ?? "";
      const identifier = /^[0-9]+$|^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[^\s/@]+@[^\s/@]+$/iu.test(target) ||
        (/^[a-z0-9]+(?:[-_:][a-z0-9]+)+$/iu.test(target) && /(?:^|[-_:])[0-9]+(?:$|[-_:])/u.test(target));
      const privateTarget = key === "account" ? identifier : hasPrivateUriTarget(target, 0) || isPrivateUrlHostname(target);
      if (!privateTarget) { chargeUrlText(text, depth); return false; }
    }
    let protectedName = privateKeys.has(key);
    if (colonTarget !== undefined && !protectedName) {
      try { assertPublicPackCatalogBytes({ [text]: null }); } catch { protectedName = true; }
    }
    // Unquoted Actor is a public credit label. Host identifies topology only
    // when its value has connection syntax; quoted/URL/JSON fields stay strict.
    const cookieHeader = key === "cookie" || key === "setcookie";
    const publicLabel = colonTarget !== undefined && (key === "actor" || key === "host" || cookieHeader);
    if (publicLabel) protectedName = cookieHeader ? cookieTarget : key === "host" && colonTarget === true;
    // Ordinary unquoted labels are prose, not new traversal nodes. Encoded
    // candidate names still decode under the same charged depth/byte budget.
    if (colonTarget !== undefined && !protectedName && !text.includes("%")) return publicLabel;
    const normalized = chargeUrlText(text, depth).normalize("NFKC");
    if (colonTarget === undefined || protectedName) keys.add(normalized);
    if (colonTarget === undefined) {
      context.code ||= key === "code"; context.authentication ||= oauthKeys.has(key);
      requireAssembly(!context.code || !context.authentication);
    }
    const decoded = decodeLayer(normalized);
    return decoded !== normalized ? inspectUrlKey(decoded, depth + 1, context, colonTarget, cookieTarget, pathTarget) : publicLabel;
  }
  function inspectConnectionAssignments(text: string, depth: number): void {
    let through = -1, endpoint = false, catalog = false, dsn = false, user = false;
    // Each match consumes one complete value. Only adjacent semicolon fields
    // share DSN context; unrelated prose or another line starts a fresh group.
    const fields = /(?:^|;)[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^=;\r\n]+))[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^;\r\n]*))[ \t]*/gmu;
    for (const match of text.matchAll(fields)) {
      if (match.index !== through) { endpoint = false; catalog = false; dsn = false; user = false; }
      through = match.index + match[0].length;
      const quoted = match[1] !== undefined || match[2] !== undefined;
      let name = match[1] ?? match[2] ?? match[3]!, keyDepth = depth + 1;
      // Encoded field names use the existing component decoder and budget.
      while (name.includes("%")) {
        name = chargeUrlText(name, keyDepth++);
        const decoded = decodeLayer(name);
        if (decoded === name) break;
        name = decoded;
      }
      const key = name.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
      const names = [key];
      if (!quoted) {
        // The existing prose scanner permits a prefix such as "Documentation".
        // At most two trailing words comprise the finite connection field names.
        const trimmed = name.trim().replace(/\s+/gu, " "), last = trimmed.lastIndexOf(" ");
        names.push(trimmed.slice(last + 1).toLowerCase().replace(/[^a-z0-9]/gu, ""));
        if (last >= 0) names.push(trimmed.slice(trimmed.lastIndexOf(" ", last - 1) + 1).toLowerCase().replace(/[^a-z0-9]/gu, ""));
      }
      const server = names.includes("server"), source = names.includes("datasource");
      const database = names.includes("database") || names.includes("initialcatalog");
      const namedSource = names.includes("dsn"), userId = names.includes("uid");
      if (!server && !source && !database && !namedSource && !userId) continue;
      chargeUrlText(name, keyDepth);
      const rawTarget = (match[4] ?? match[5] ?? match[6]!).trim();
      let target = rawTarget, targetDepth = depth + 1;
      if (server || source) {
        // Decode the assignment value only until a public URL is recognizable;
        // its encoded path/query separators remain the existing URL visitor's job.
        while (!/^https?:\/\//iu.test(target) && target.includes("%")) {
          target = chargeUrlText(target, targetDepth++);
          const decoded = decodeLayer(target);
          if (decoded === target) break;
          target = decoded.trim();
        }
        const connection = hasPrivateUriTarget(target, 0) || /,[ \t]*[0-9]{1,5}$/u.test(target) || isPrivateUrlHostname(target);
        const publicSourceUrl = source && /^https?:\/\//iu.test(target);
        requireAssembly(!connection || publicSourceUrl);
        if (publicSourceUrl && target !== rawTarget) inspectUrlText(target, targetDepth, false);
        // Two explicit endpoint/catalog fields establish DSN context without
        // guessing a hostname grammar for quoted, braced or named instances.
        endpoint ||= target !== "";
      }
      catalog ||= database && target !== "";
      dsn ||= namedSource && target !== ""; user ||= userId && target !== "";
      // UID alone can identify a public card. Adjacent connection fields supply
      // account context without globally protecting every UID label.
      requireAssembly(!(endpoint && catalog) && !(dsn && (endpoint || catalog)) && !(user && (dsn || endpoint || catalog)));
    }
  }
  function inspectProseAssignments(rawText: string, depth: number): void {
    // Match schema-equivalent field spelling without rewriting public bytes.
    const text = rawText.normalize("NFKC");
    if (text !== rawText) chargeUrlText(rawText, depth);
    // Percent decoding here is recognition-only: retain frame punctuation that
    // splits lexical assignment runs, without manufacturing URL/form structure.
    // Every layer shares the same depth, node and byte counters as URL traversal.
    let recognitionText = text, recognitionDepth = depth;
    while (recognitionText.includes("%")) {
      const decoded = decodeLayer(recognitionText);
      if (decoded === recognitionText) break;
      chargeUrlText(decoded, ++recognitionDepth, true);
      recognitionText = decoded;
    }
    inspectConnectionAssignments(text, depth);
    // Quoted names are explicit fields, including punctuation and whitespace.
    // Consume each complete quoted span and charge its full name without truncation.
    for (const match of text.matchAll(/"([^"]*)"\s*([:=]|%[a-z0-9%_.-]*)|'([^']*)'\s*([:=]|%[a-z0-9%_.-]*)/giu)) {
      let separator = match[2] ?? match[4]!, separatorDepth = depth + 1;
      // Only the following lexical component can reveal this assignment's
      // separator. Never decode an unbounded suffix or a whole URL here.
      while (!/^[:=]/u.test(separator) && separator.includes("%")) {
        const decoded = decodeLayer(chargeUrlText(separator, separatorDepth++));
        if (decoded === separator) break;
        separator = decoded.trim();
      }
      if (/^[:=]/u.test(separator)) inspectUrlKey(match[1] ?? match[3]!, separatorDepth, { authentication: false, code: false });
    }
    // Consume full runs even without '='; bounded suffixes recognize spaced or
    // quoted names without treating ordinary colon labels as structured fields.
    for (const match of text.matchAll(/[a-z0-9%_.-]+(?:[ \t]+[a-z0-9%_.-]+)*/giu)) {
      // Decode one lexical run, never a complete URL's structural delimiters.
      // Re-enter under the same counters so encoded assignment punctuation and
      // quoted names retain the existing explicit-field rules at every layer.
      if (match[0].includes("%")) {
        const decoded = decodeLayer(chargeUrlText(match[0], depth + 1));
        if (decoded !== match[0]) inspectProseAssignments(decoded, depth + 1);
      }
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
        // Do not turn preceding prose ("Secret edition code=SUMMER") into
        // part of the assigned name. Quoted names are explicitly structural.
        if (index < words.length - 1 && !/["']/u.test(text[match.index - 1] ?? "")) {
          try { assertPublicPackCatalogBytes({ [words[index]!]: null }); } catch { break; }
        }
        key = words[index]! + (key === "" ? "" : ` ${key}`);
        if (key.length > 256) break;
        // URL/form parsing owns contextual OAuth codes; lexical assignment
        // discovery must not join separate URLs into one authentication context.
        const publicLabel = inspectUrlKey(key, depth + 1, { authentication: false, code: false }, colonTarget, cookieTarget);
        // A recognized public credit/host label ends the name. Preceding prose
        // must not turn "Premium Actor:" into a different protected field.
        if (publicLabel) break;
      }
    }
  }
  function urlRecognition(normalized: string): string {
    // Match WHATWG scheme/authority recognition, without changing query-value structure.
    const withoutControls = normalized.replaceAll("\t", "").replaceAll("\n", "").replaceAll("\r", "");
    let start = 0, end = withoutControls.length;
    while (start < end && withoutControls.charCodeAt(start) <= 32) start += 1;
    while (end > start && withoutControls.charCodeAt(end - 1) <= 32) end -= 1;
    return withoutControls.slice(start, end).replaceAll("\\", "/");
  }
  function authenticationRoute(path: string, depth: number): boolean {
    if (/(?:^|\/)(?:oauth2?|oidc|auth|authorize|authorization|callback|login|signin|sign-in|signin-oidc|sso)(?:[-_]callback)?(?:\/|$|[.;])/iu.test(path.replaceAll("\\", "/"))) return true;
    const decoded = decodeLayer(path);
    return decoded !== path && authenticationRoute(chargeUrlText(decoded, depth + 1), depth + 1);
  }
  function inspectPath(path: string, depth: number, context: OAuthContext): void {
    // Each nonempty name needs a following value. Iterate without allocating
    // an array proportional to the number of slashes in a bounded large URL.
    const normalized = path.replaceAll("\\", "/");
    for (const match of normalized.matchAll(/[^/]+/gu)) {
      let next = match.index + match[0].length;
      while (normalized[next] === "/") next += 1;
      let end = next;
      while (end < normalized.length && normalized[end] !== "/") end += 1;
      if (next < normalized.length) inspectUrlKey(match[0], depth + 1, context, undefined, false, normalized.slice(next, end));
    }
    // Decode only this pathname component, never authority/query boundaries.
    const decoded = decodeLayer(normalized);
    if (decoded !== normalized) { chargeUrlText(decoded, depth + 1); inspectPath(decoded, depth + 1, context); }
  }
  function stringTokenEnd(text: string, start: number): number {
    let index = start + 1;
    while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
    return index < text.length ? index + 1 : text.length + 1;
  }
  const arrayScalarPrefix = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)\s*(?=[,\]]|$)/iyu;
  function isProseContainer(text: string, start: number): boolean {
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
    // One numeric comma does not establish JSON: [1,000 cards] is prose.
    // Look ahead over the scalar sequence once; the charged parser owns syntax.
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
  }
  function inspectLeadingStructuredText(text: string, depth: number, context: OAuthContext): boolean {
    // Natural labels such as [1/1], {Limited Edition}, or a quoted name followed
    // by prose do not establish a whole JSON document, including inside captions.
    if ((text[0] === "{" || text[0] === "[") && isProseContainer(text, 0)) {
      inspectStructuredText(text, depth, context); return true;
    }
    return text[0] === '"' && stringTokenEnd(text, 0) === text.length &&
      inspectStructuredText(text, depth, context, 0, true) > 0;
  }
  function inspectStructuredText(text: string, depth: number, context: OAuthContext, prefixStart?: number, proseString = false): number {
    // Inspect every token before parsing the document: JSON.parse alone would
    // discard protected values hidden by duplicate object keys. Charge this
    // same traversal before allocating a parsed document or descending further.
    let nesting = 0, index = prefixStart ?? 0;
    while (index < text.length) {
      const start = index, character = text[index++]!;
      if (/\s|[,:]/u.test(character)) continue;
      if (character === "{" || character === "[") {
        nesting += 1; chargeUrlText(character, depth + nesting); continue;
      }
      if (character === "}" || character === "]") {
        requireAssembly(nesting > 0); nesting -= 1;
        if (prefixStart !== undefined && nesting === 0) break;
        continue;
      }
      if (character === '"') {
        index = stringTokenEnd(text, start);
        if (proseString && index > text.length) return -index;
        requireAssembly(index <= text.length);
        const token = text.slice(start, index);
        let decoded: string;
        try { decoded = JSON.parse(token) as string; }
        catch { if (proseString) return -index; requireAssembly(false); return index; }
        let next = index;
        while (next < text.length && /\s/u.test(text[next]!)) next += 1;
        if (text[next] === ":") inspectUrlKey(decoded, depth + nesting + 1, context);
        else inspectUrlText(decoded, depth + nesting + 1, false, context);
        if (prefixStart !== undefined && nesting === 0) break;
      } else {
        while (index < text.length && !/[\s{}[\]",:]/u.test(text[index]!)) index += 1;
        chargeUrlText(text.slice(start, index), depth + nesting + 1);
      }
    }
    requireAssembly(nesting === 0);
    try { JSON.parse(prefixStart === undefined ? text : text.slice(prefixStart, index)); }
    catch { requireAssembly(false); }
    return index;
  }
  function inspectProseStructuredText(text: string, depth: number, context?: OAuthContext, charged = false): void {
    // Absolute offsets consume complete roots without repeatedly parsing the
    // remaining suffix. Natural brace/bracket labels do not establish JSON.
    // Quoted prose is only decoded when it contains escapes; malformed or lone
    // prose quotes remain text. The closing quote can also start an explicit
    // JSON key, so an earlier prose quote cannot hide an escaped field name.
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
      if (!charged) { chargeUrlText(text, depth); charged = true; }
      // Independent public prose roots do not create an OAuth relationship.
      // URL/form descendants instead retain their enclosing explicit context.
      const end = inspectStructuredText(text, depth, context ?? { authentication: false, code: false }, index, quoted);
      if (end > 0) index = end - (quoted ? 2 : 1);
    }
  }
  function inspectFragment(text: string, depth: number, context: OAuthContext): void {
    const normalized = chargeUrlText(text, depth);
    inspectProseAssignments(normalized, depth);
    rejectCredentialText(normalized, target => {
      if (target !== normalized) inspectEmbeddedTarget(target, depth + 1);
    });
    if (inspectLeadingStructuredText(normalized, depth, context)) return;
    const isTarget = (value: string) => {
      const candidate = urlRecognition(value), query = candidate.indexOf("?"), equals = candidate.indexOf("=");
      return /^[a-z][a-z0-9+.-]*:|^[/?]|^\.\.?[/]/iu.test(candidate) ||
        (query >= 0 && (equals < 0 || query < equals));
    };
    if (isTarget(normalized)) { inspectUrlText(normalized, depth + 1, false, context); return; }
    const decoded = decodeLayer(normalized);
    if (decoded !== normalized && (isTarget(decoded) || !normalized.includes("="))) {
      inspectFragment(decoded, depth + 1, context); return;
    }
    inspectProseStructuredText(normalized, depth, context, true);
    inspectForm(normalized, depth, context);
  }
  function inspectForm(text: string, depth: number, context: OAuthContext): void {
    for (const [key, nested] of new URLSearchParams(text)) {
      inspectUrlKey(key, depth + 1, context); inspectUrlText(nested, depth + 1, false, context);
    }
  }
  function inspectEmbeddedTarget(text: string, depth = 0): void {
    // Trim only embedded prose punctuation, never a required/raw URL. Preserve
    // the authority's closing IPv6 bracket; full userinfo was checked first.
    const authorityEnd = /^(?:[a-z][a-z0-9+.\-\t\n\r]*:)?[/\\\t\n\r]*\[[^\]]+\]/iu.exec(text)?.[0].length ?? 0;
    // Query/fragment JSON closing delimiters belong to the component, not prose.
    const trailingProse = /[?#]/u.test(text) ? /["'<>()[{,.;]+$/gu : /["'<>()[\]{},.;]+$/gu;
    const trimmedLength = text.replace(trailingProse, "").length;
    inspectUrlText(text.slice(0, Math.max(authorityEnd, trimmedLength)), depth);
  }
  function inspectUrlText(text: string, depth = 0, required = false, context: OAuthContext = { authentication: false, code: false }): void {
    const normalized = chargeUrlText(text, depth), candidate = urlRecognition(normalized);
    // Decoded JSON/form captions can reveal an embedded URL only at this layer.
    // Reuse the same traversal; an exact whole-text URL is parsed below instead
    // of recursively inspecting itself or starting a fresh public-data budget.
    if (!required) rejectCredentialText(normalized, target => {
      if (target !== normalized) inspectEmbeddedTarget(target, depth + 1);
    });
    if (!required) inspectProseAssignments(normalized, depth);
    if (!required && inspectLeadingStructuredText(normalized, depth, context)) return;
    if (!required) inspectProseStructuredText(normalized, depth, context, true);
    // Dispatch a form by its leading assignment, even when its value contains
    // a literal question mark or fragment marker. URL paths retain precedence.
    const assignment = candidate.indexOf("="), marker = candidate.search(/[?#]/u);
    if (!required && !/^[a-z][a-z0-9+.-]*:|^(?:\/|\.\.?\/)/iu.test(candidate) &&
      assignment >= 0 && (marker < 0 || assignment < marker)) {
      inspectForm(normalized, depth, context); return;
    }
    if (!required && !candidate.startsWith("/") && !/^[a-z][a-z0-9+.-]*:|[?#]/iu.test(candidate)) {
      const decoded = decodeLayer(normalized);
      if (decoded !== normalized) inspectUrlText(decoded, depth + 1, false, context);
      return;
    }
    let url: URL;
    try { url = required || /^[a-z][a-z0-9+.-]*:/iu.test(candidate) ? new URL(normalized) : new URL(normalized, "https://public.invalid"); }
    catch { requireAssembly(false); return; }
    requireAssembly(url.username === "" && url.password === "" && !isPrivateUrlHostname(url.hostname));
    // A separate nested URL has its own route/query context; forms and JSON
    // within this URL share it, regardless of parameter or duplicate-key order.
    const originalPath = originalUrlPath(candidate);
    const urlContext = { authentication: authenticationRoute(url.pathname, depth) ||
      (originalPath !== url.pathname && authenticationRoute(originalPath, depth)) ||
      (/^[?#]/u.test(candidate) && context.authentication), code: false };
    inspectPath(originalPath, depth, urlContext);
    if (originalPath !== url.pathname) inspectPath(url.pathname, depth, urlContext);
    // Preserve URL structure: decode individual names/values, never the whole URL.
    for (const [key, nested] of url.searchParams) {
      inspectUrlKey(key, depth + 1, urlContext); inspectUrlText(nested, depth + 1, false, urlContext);
    }
    const fragment = url.hash.slice(1);
    if (fragment !== "") inspectFragment(fragment, depth + 1, urlContext);
    // URL removes TAB/LF/CR before exposing search/hash. Retain original
    // component evidence too, without decoding URL structure or charging an
    // ordinary unchanged component twice.
    const hash = normalized.indexOf("#"), query = normalized.indexOf("?");
    const originalQuery = query >= 0 && (hash < 0 || query < hash) ? normalized.slice(query + 1, hash < 0 ? undefined : hash) : "";
    if (originalQuery !== url.search.slice(1)) inspectForm(originalQuery, depth, urlContext);
    const originalFragment = hash >= 0 ? normalized.slice(hash + 1) : "";
    if (originalFragment !== fragment) inspectFragment(originalFragment, depth + 1, urlContext);
  }
  function visit(item: unknown, depth: number, field = "") {
    requireAssembly(++nodes <= limits.maximumNodes && depth <= limits.maximumDepth);
    if (typeof item === "string") {
      requireAssembly(item.length <= limits.maximumSnapshotBytes);
      bytes += encoder.encode(item).byteLength;
      const urlField = field === "url" || field === "imageUrl";
      rejectCredentialText(item, urlField ? undefined : target => inspectEmbeddedTarget(target));
      if (!urlField) {
        const normalized = item.trim().normalize("NFC");
        inspectProseStructuredText(normalized, 0);
        inspectProseAssignments(normalized, 0);
      }
      if (urlField) {
        inspectUrlText(item, 0, true);
      }
    } else if (item === null || item === undefined || typeof item === "boolean") bytes += 5;
    else if (typeof item === "number") { requireAssembly(Number.isSafeInteger(item) && !Object.is(item, -0)); bytes += 20; }
    else {
      requireAssembly(typeof item === "object" && !isProxy(item) && !ancestors.has(item));
      const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
      requireAssembly(array ? prototype === Array.prototype && item.length <= 10_000 : prototype === Object.prototype || prototype === null);
      const names = Reflect.ownKeys(item);
      requireAssembly(names.length <= (array ? 10_001 : 128));
      ancestors.add(item);
      for (const key of names) {
        requireAssembly(typeof key === "string" && key.length <= 256);
        if (array && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        requireAssembly("value" in descriptor && descriptor.enumerable);
        if (array) requireAssembly(/^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < item.length);
        else { keys.add(key); bytes += encoder.encode(key).byteLength; }
        visit(descriptor.value, depth + 1, key);
      }
      if (array) requireAssembly(names.length === item.length + 1);
      ancestors.delete(item);
    }
    requireAssembly(bytes <= limits.maximumInputBytes);
  }
  visit(value, 0);
  for (const key of keys) requireAssembly(!privateKeys.has(key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "")));
  // Scan raw field/query names before schema parsing; normalize public text later.
  try { assertPublicPackCatalogBytes(Object.fromEntries([...keys].map(key => [key, null]))); }
  catch { requireAssembly(false); }
}

function record(value: unknown): Record<string, unknown> {
  requireAssembly(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function ordered<T>(value: unknown, parse: (item: unknown) => T, key: (item: T) => string): T[] {
  requireAssembly(Array.isArray(value));
  return value.map(parse).sort((a, b) => compareCanonicalStrings(key(a), key(b)));
}
const dependency = packSnapshotEvidenceSchema.shape.sharedDependencies.element;
const dependencies = (value: unknown) => ordered(value, item => dependency.parse(item), item => `${item.kind}:${item.identity}`);

/** Runs entirely before the assembler's first await. */
export function capturePackAssemblyInput(raw: unknown) {
  assertPackAssemblyPublicData(raw);
  const source = record(raw);
  // Bound every supplied candidate before cloning/parsing, even when its identity will not be reused.
  if (source.existingSnapshot !== undefined && source.existingSnapshot !== null) {
    requireAssembly(packCatalogCanonicalByteCount(source.existingSnapshot) <= limits.maximumSnapshotBytes);
  }
  const value = record(structuredClone(source));
  requireAssembly(Object.keys(value).every(key => ["request", "inputs", "existingSnapshot"].includes(key)));
  const candidate = record(value.inputs), request = record(value.request), evidence = record(request.evidence);
  const shape = providerPackBuildInputsSchema.shape;
  const inputs = providerPackBuildInputsSchema.parse({ ...candidate,
    contents: ordered(candidate.contents, item => shape.contents.element.parse(item), item => item.publicCollectibleId),
    aliases: ordered(candidate.aliases, item => shape.aliases.element.parse(item), item => item),
    actions: ordered(candidate.actions, item => shape.actions.element.parse(item), item => item.actionId),
    expectedDependencies: dependencies(candidate.expectedDependencies), observedDependencies: dependencies(candidate.observedDependencies),
  });
  const buildRequest = packBuildRequestSchema.parse({ ...request,
    requiredProfileSnapshotIds: ordered(request.requiredProfileSnapshotIds, item => publicProfileSnapshotIdSchema.parse(item), item => item),
    evidence: { ...evidence, sharedDependencies: dependencies(evidence.sharedDependencies) },
  });
  return { inputs, request: buildRequest, existingSnapshot: value.existingSnapshot ?? null };
}

export function freezePackAssembly<T>(value: T): T {
  const seen = new Set<object>();
  function freeze(item: unknown) {
    if (item === null || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  }
  freeze(value);
  return value;
}
