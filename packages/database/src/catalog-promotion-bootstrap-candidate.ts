import {
  canonicalJson,
  catalogManifestActivateRequestSchema,
  type ActiveCatalogManifestStateV1,
} from "@packscout/contracts";

function parseActivate(body: string) {
  try {
    const parsed = catalogManifestActivateRequestSchema.safeParse(
      JSON.parse(body),
    );
    return parsed.success && canonicalJson(parsed.data) === body
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

function matchesActiveManifest(
  request: ReturnType<typeof parseActivate>,
  activeManifest: NonNullable<ActiveCatalogManifestStateV1["activeManifest"]>,
): boolean {
  return request !== null &&
    request.manifest.publicReleaseId === activeManifest.publicReleaseId &&
    request.manifest.manifestFingerprint ===
      activeManifest.manifestFingerprint &&
    request.manifest.providerReferenceSetHash ===
      activeManifest.providerReferenceSetHash;
}

/** Selects one proven immutable manifest despite distinct activation transitions. */
export function selectManifestDefinitionRequestBody(input: Readonly<{
  activeManifest: NonNullable<ActiveCatalogManifestStateV1["activeManifest"]>;
  terminalRequestBody: string | null;
  definitionRequestBodies: readonly string[];
}>): string | null {
  const candidates = input.definitionRequestBodies.flatMap((body) => {
    const request = parseActivate(body);
    return matchesActiveManifest(request, input.activeManifest) && request
      ? [{ body, manifestBody: canonicalJson(request.manifest) }]
      : [];
  });
  const terminal = input.terminalRequestBody === null
    ? null
    : parseActivate(input.terminalRequestBody);
  const preferred = matchesActiveManifest(terminal, input.activeManifest) &&
      terminal !== null
    ? {
        body: input.terminalRequestBody!,
        manifestBody: canonicalJson(terminal.manifest),
      }
    : candidates[0] ?? null;
  if (preferred === null || candidates.some((candidate) =>
    candidate.manifestBody !== preferred.manifestBody)) return null;
  return preferred.body;
}
