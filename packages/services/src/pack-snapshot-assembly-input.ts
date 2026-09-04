import { isProxy } from "node:util/types";
import { assertPublicPackCatalogBytes, compareCanonicalStrings, packBuildRequestSchema, packCatalogCanonicalByteCount,
  packSnapshotEvidenceSchema, providerPackBuildInputsSchema, publicProfileSnapshotIdSchema } from "@packscout/contracts";
import { packSnapshotAssemblyLimits as limits, requireAssembly } from "./pack-snapshot-assembly-types.ts";

const privateKeys = new Set(["account", "accountid", "authorization", "connectionstring", "connectionurl",
  "databaseurl", "databasetarget", "host", "port", "stack", "stacktrace", "instanceid", "exactinstance",
  "userid", "userdata", "rawsourceevidence", "sig", "xamzsignature", "signature"]);

/** Inspect descriptors before cloning so getters, cycles and mutable handles cannot
 * execute during capture. Unknown schema fields are rejected, never stripped. */
function preflight(value: unknown): void {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>(), keys = new Set<string>();
  const encoder = new TextEncoder();
  function visit(item: unknown, depth: number, field = "") {
    requireAssembly(++nodes <= limits.maximumNodes && depth <= limits.maximumDepth);
    if (typeof item === "string") {
      requireAssembly(item.length <= limits.maximumSnapshotBytes);
      bytes += encoder.encode(item).byteLength;
      const normalizedText = item.trim().normalize("NFC");
      requireAssembly(!/^(?:postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/|redis(?:s)?:\/\/|-----BEGIN .*PRIVATE KEY-----|Bearer [A-Za-z0-9._~-]{20,})/iu.test(normalizedText));
      if (field === "url" || field === "imageUrl") {
        for (const key of new URL(item).searchParams.keys()) keys.add(key);
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
  assertPublicPackCatalogBytes(Object.fromEntries([...keys].map(key => [key, null])));
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
  preflight(raw);
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
