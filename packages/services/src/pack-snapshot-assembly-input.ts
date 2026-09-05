import { Buffer } from "node:buffer";
import { isProxy } from "node:util/types";
import { assertPublicPackCatalogBytes, compareCanonicalStrings, packBuildRequestSchema, packCatalogCanonicalByteCount,
  packSnapshotEvidenceSchema, providerPackBuildInputsSchema, publicProfileSnapshotIdSchema } from "@packscout/contracts";
import { packSnapshotAssemblyLimits as limits, requireAssembly } from "./pack-snapshot-assembly-types.ts";

const privateKeys = new Set(["account", "accountid", "authorization", "authorizationcode", "codeverifier", "connectionstring", "connectionurl",
  "databaseurl", "databasetarget", "host", "port", "stack", "stacktrace", "instanceid", "exactinstance",
  "userid", "userdata", "rawsourceevidence", "sig", "xamzsignature", "signature"]);
const credentialText = /(?:postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/|redis(?:s)?:\/\/|-----BEGIN .*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{20,})/iu;
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
function rejectCredentialText(value: string, inspectEmbeddedUrl?: (target: string) => void): void {
  const normalized = value.trim().normalize("NFC");
  requireAssembly(!credentialText.test(normalized));
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
  let match: RegExpExecArray | null, authorityThrough = 0, parsedThrough = 0;
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
    if (inspectEmbeddedUrl && match.index >= parsedThrough) {
      end = colon + 1;
      while (end < recognized.length && !/[\s<>"']/u.test(recognized[end]!)) end += 1;
      parsedThrough = end;
      inspectEmbeddedUrl(recognized.slice(match.index, end));
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
  function chargeUrlText(text: string, depth: number): string {
    requireAssembly(++urlNodes <= limits.maximumNodes && depth <= limits.maximumDepth);
    urlBytes += encoder.encode(text).byteLength;
    requireAssembly(urlBytes <= limits.maximumInputBytes);
    rejectCredentialText(text);
    return text.trim().normalize("NFC");
  }
  function inspectUrlKey(text: string, depth: number, context: OAuthContext): void {
    const normalized = chargeUrlText(text, depth);
    keys.add(normalized);
    const key = normalized.toLowerCase().replace(/[^a-z0-9]/gu, "");
    context.code ||= key === "code"; context.authentication ||= oauthKeys.has(key);
    requireAssembly(!context.code || !context.authentication);
    const decoded = decodeLayer(normalized);
    if (decoded !== normalized) inspectUrlKey(decoded, depth + 1, context);
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
    if (/(?:^|\/)(?:oauth2?|oidc|auth|authorize|authorization|callback|login|signin|sign-in|signin-oidc|sso)(?:[-_]callback)?(?:\/|$|[.;])/iu.test(path)) return true;
    const decoded = decodeLayer(path);
    return decoded !== path && authenticationRoute(chargeUrlText(decoded, depth + 1), depth + 1);
  }
  const isStructuredText = (text: string) => /^[{["]/u.test(text);
  function inspectStructuredText(text: string, depth: number, context: OAuthContext): void {
    // Inspect every token before parsing the document: JSON.parse alone would
    // discard protected values hidden by duplicate object keys. Charge this
    // same traversal before allocating a parsed document or descending further.
    let nesting = 0, index = 0;
    while (index < text.length) {
      const start = index, character = text[index++]!;
      if (/\s|[,:]/u.test(character)) continue;
      if (character === "{" || character === "[") {
        nesting += 1; chargeUrlText(character, depth + nesting); continue;
      }
      if (character === "}" || character === "]") { requireAssembly(nesting > 0); nesting -= 1; continue; }
      if (character === '"') {
        while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
        requireAssembly(index < text.length); index += 1;
        const token = text.slice(start, index);
        let decoded: string;
        try { decoded = JSON.parse(token) as string; }
        catch { requireAssembly(false); return; }
        let next = index;
        while (next < text.length && /\s/u.test(text[next]!)) next += 1;
        if (text[next] === ":") inspectUrlKey(decoded, depth + nesting + 1, context);
        else inspectUrlText(decoded, depth + nesting + 1, false, context);
      } else {
        while (index < text.length && !/[\s{}[\]",:]/u.test(text[index]!)) index += 1;
        chargeUrlText(text.slice(start, index), depth + nesting + 1);
      }
    }
    requireAssembly(nesting === 0);
    try { JSON.parse(text); }
    catch { requireAssembly(false); }
  }
  function inspectFragment(text: string, depth: number, context: OAuthContext): void {
    const normalized = chargeUrlText(text, depth);
    if (isStructuredText(normalized)) { inspectStructuredText(normalized, depth, context); return; }
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
    inspectForm(normalized, depth, context);
  }
  function inspectForm(text: string, depth: number, context: OAuthContext): void {
    for (const [key, nested] of new URLSearchParams(text)) {
      inspectUrlKey(key, depth + 1, context); inspectUrlText(nested, depth + 1, false, context);
    }
  }
  function inspectUrlText(text: string, depth = 0, required = false, context: OAuthContext = { authentication: false, code: false }): void {
    const normalized = chargeUrlText(text, depth), candidate = urlRecognition(normalized);
    if (!required && isStructuredText(normalized)) { inspectStructuredText(normalized, depth, context); return; }
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
    try { url = required ? new URL(normalized) : new URL(normalized, "https://public.invalid"); }
    catch { requireAssembly(false); return; }
    requireAssembly(url.username === "" && url.password === "");
    // A separate nested URL has its own route/query context; forms and JSON
    // within this URL share it, regardless of parameter or duplicate-key order.
    const urlContext = { authentication: authenticationRoute(url.pathname, depth) ||
      (/^[?#]/u.test(candidate) && context.authentication), code: false };
    // Preserve URL structure: decode individual names/values, never the whole URL.
    for (const [key, nested] of url.searchParams) {
      inspectUrlKey(key, depth + 1, urlContext); inspectUrlText(nested, depth + 1, false, urlContext);
    }
    const fragment = url.hash.slice(1);
    if (fragment !== "") inspectFragment(fragment, depth + 1, urlContext);
  }
  function visit(item: unknown, depth: number, field = "") {
    requireAssembly(++nodes <= limits.maximumNodes && depth <= limits.maximumDepth);
    if (typeof item === "string") {
      requireAssembly(item.length <= limits.maximumSnapshotBytes);
      bytes += encoder.encode(item).byteLength;
      const urlField = field === "url" || field === "imageUrl";
      rejectCredentialText(item, urlField ? undefined : target => inspectUrlText(target));
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
  for (const key of keys) requireAssembly(!privateKeys.has(key.toLowerCase().replace(/[^a-z0-9]/gu, "")));
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
