import { isProxy } from "node:util/types";
import { assertPublicPackCatalogBytes, compareCanonicalStrings, packBuildRequestSchema, packCatalogCanonicalByteCount,
  packSnapshotEvidenceSchema, providerPackBuildInputsSchema, publicProfileSnapshotIdSchema } from "@packscout/contracts";
import { packSnapshotAssemblyLimits as limits, requireAssembly } from "./pack-snapshot-assembly-types.ts";

const privateKeys = new Set(["account", "accountid", "authorization", "authorizationcode", "connectionstring", "connectionurl",
  "databaseurl", "databasetarget", "host", "port", "stack", "stacktrace", "instanceid", "exactinstance",
  "userid", "userdata", "rawsourceevidence", "sig", "xamzsignature", "signature"]);
const credentialText = /(?:postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/|redis(?:s)?:\/\/|-----BEGIN .*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{20,})/iu;
function rejectCredentialText(value: string, inspectEmbeddedUrl?: (target: string) => void): void {
  const normalized = value.trim().normalize("NFC");
  requireAssembly(!credentialText.test(normalized));
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
  function inspectUrlKey(text: string, depth: number): void {
    const normalized = chargeUrlText(text, depth);
    keys.add(normalized);
    const decoded = decodeLayer(normalized);
    if (decoded !== normalized) inspectUrlKey(decoded, depth + 1);
  }
  function urlRecognition(normalized: string): string {
    // Match WHATWG scheme/authority recognition, without changing query-value structure.
    const withoutControls = normalized.replaceAll("\t", "").replaceAll("\n", "").replaceAll("\r", "");
    let start = 0, end = withoutControls.length;
    while (start < end && withoutControls.charCodeAt(start) <= 32) start += 1;
    while (end > start && withoutControls.charCodeAt(end - 1) <= 32) end -= 1;
    return withoutControls.slice(start, end).replaceAll("\\", "/");
  }
  const isStructuredText = (text: string) => /^[{["]/u.test(text);
  function inspectStructuredText(text: string, depth: number): void {
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
        if (text[next] === ":") inspectUrlKey(decoded, depth + nesting + 1);
        else inspectUrlText(decoded, depth + nesting + 1);
      } else {
        while (index < text.length && !/[\s{}[\]",:]/u.test(text[index]!)) index += 1;
        chargeUrlText(text.slice(start, index), depth + nesting + 1);
      }
    }
    requireAssembly(nesting === 0);
    try { JSON.parse(text); }
    catch { requireAssembly(false); }
  }
  function inspectFragment(text: string, depth: number): void {
    const normalized = chargeUrlText(text, depth);
    if (isStructuredText(normalized)) { inspectStructuredText(normalized, depth); return; }
    const isTarget = (value: string) => {
      const candidate = urlRecognition(value), query = candidate.indexOf("?"), equals = candidate.indexOf("=");
      return /^[a-z][a-z0-9+.-]*:|^[/?]|^\.\.?[/]/iu.test(candidate) ||
        (query >= 0 && (equals < 0 || query < equals));
    };
    if (isTarget(normalized)) { inspectUrlText(normalized, depth + 1); return; }
    const decoded = decodeLayer(normalized);
    if (decoded !== normalized && (isTarget(decoded) || !normalized.includes("="))) {
      inspectFragment(decoded, depth + 1); return;
    }
    inspectForm(normalized, depth);
  }
  function inspectForm(text: string, depth: number): void {
    for (const [key, nested] of new URLSearchParams(text)) {
      inspectUrlKey(key, depth + 1); inspectUrlText(nested, depth + 1);
    }
  }
  function inspectUrlText(text: string, depth = 0, required = false): void {
    const normalized = chargeUrlText(text, depth), candidate = urlRecognition(normalized);
    if (!required && isStructuredText(normalized)) { inspectStructuredText(normalized, depth); return; }
    // Dispatch a form by its leading assignment, even when its value contains
    // a literal question mark or fragment marker. URL paths retain precedence.
    const assignment = candidate.indexOf("="), marker = candidate.search(/[?#]/u);
    if (!required && !/^[a-z][a-z0-9+.-]*:|^(?:\/|\.\.?\/)/iu.test(candidate) &&
      assignment >= 0 && (marker < 0 || assignment < marker)) {
      inspectForm(normalized, depth); return;
    }
    if (!required && !candidate.startsWith("/") && !/^[a-z][a-z0-9+.-]*:|[?#]/iu.test(candidate)) {
      const decoded = decodeLayer(normalized);
      if (decoded !== normalized) inspectUrlText(decoded, depth + 1);
      return;
    }
    let url: URL;
    try { url = required ? new URL(normalized) : new URL(normalized, "https://public.invalid"); }
    catch { requireAssembly(false); return; }
    requireAssembly(url.username === "" && url.password === "");
    // Preserve URL structure: decode individual names/values, never the whole URL.
    for (const [key, nested] of url.searchParams) {
      inspectUrlKey(key, depth + 1); inspectUrlText(nested, depth + 1);
    }
    const fragment = url.hash.slice(1);
    if (fragment !== "") inspectFragment(fragment, depth + 1);
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
