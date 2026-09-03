import { DATAFORREST_EVENTS_V1_ENDPOINT, dataforrestCourtyardDistributedSourceAdapterManifest as manifest,
  dataforrestEventsConnectionConfigurationV1Schema, dataforrestEventsPageV1Schema,
  dataforrestEventRecordV1Schema, emptyNormalizedProviderFacts } from "@packscout/contracts";
import { captureHardenedProviderResponse, DataforrestEventsSourceAdapter,
  createProviderObservationMapperRegistryFromManifest, providerSourceCanonicalProjectionsForValidatedMapping } from "@packscout/services";
import { validateProviderMixedPageRecord } from "@packscout/database";
import { collectibleDraft } from "../../apps/worker/src/provider-observation-mixed-page-drafts.ts";
import { ProviderCaptureSourceError } from "../../apps/worker/src/provider-capture-source-contract.ts";
import { handoffDigest } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { assertCourtyardProfileContinuity, courtyardHandoff as pins, courtyardCanarySchema,
  refuseCourtyardHandoff as refuse, type CourtyardCanaryProof } from "./courtyard-checkpoint-handoff-plan.mts";

export { ProviderCaptureSourceError };
/** Only the reviewed wrapper-absent, wholly absent card-facts shape may explain this draft rejection. */
export function isReviewedCourtyardMissingNameRejection(input: Readonly<{ error: unknown;
  nativeData: Readonly<Record<string, unknown>>; normalizedFacts: unknown; candidateDisplayName: unknown }>) {
  return input.error instanceof ProviderCaptureSourceError && input.error.code === "PROVIDER_CAPTURE_RECORD_INVALID" &&
    !Object.hasOwn(input.nativeData, "asset") && !Object.hasOwn(input.nativeData, "reveal") && input.candidateDisplayName === null &&
    handoffDigest(input.normalizedFacts) === handoffDigest(emptyNormalizedProviderFacts("card"));
}

/** Raw inspection deliberately grants no durable request/page/native-evidence capability. */
export async function probeCourtyardHandoff(input: Readonly<{ token: string; opaqueCursor: string;
  providerId: string; nextConfigId: string; captureResponse?: typeof captureHardenedProviderResponse }>): Promise<CourtyardCanaryProof> {
  const descriptor = assertCourtyardProfileContinuity();
  if (!dataforrestEventsConnectionConfigurationV1Schema.safeParse({ endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken: input.token }).success || !input.opaqueCursor || input.opaqueCursor.length > 16384) refuse("COURTYARD_CANARY_AUTHORITY_INVALID");
  const url = new URL(DATAFORREST_EVENTS_V1_ENDPOINT);
  url.searchParams.set("platform", pins.providerKey); url.searchParams.set("limit", "100"); url.searchParams.set("cursor", input.opaqueCursor);
  let response;
  try { response = await (input.captureResponse ?? captureHardenedProviderResponse)({ url, allowedHosts: [url.hostname],
    headers: { Accept: "application/json", Authorization: `Bearer ${input.token}` },
    timeoutMilliseconds: manifest.requestBounds.timeoutMilliseconds, maximumResponseBytes: manifest.requestBounds.maximumResponseBytes,
    signal: new AbortController().signal }); } catch { return refuse("COURTYARD_CANARY_TRANSPORT_FAILED"); }
  try {
    if (response.status !== 200 || response.responseBytes !== response.protectedBody.byteLength ||
      !Number.isFinite(response.durationMilliseconds) || response.durationMilliseconds < 0) refuse("COURTYARD_CANARY_RESPONSE_INVALID");
    const inspected = new DataforrestEventsSourceAdapter({}, manifest).inspectRawResponse({ provider: "courtyard",
      sourceTypeKey: manifest.sourceTypeKey, adapterVersion: manifest.adapterVersion, pageLimit: 100,
      protectedRawResponse: response.protectedBody });
    if (!inspected.ok || inspected.recordCount !== 100 || inspected.continuation.kind !== "continue") refuse("COURTYARD_CANARY_PARSER_REJECTED");
    // Structural corroboration only, AFTER the production byte/graph/wire parser passed.
    // Retain positional envelope identity; never reinterpret a native label or return raw fields.
    const wire = dataforrestEventsPageV1Schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.protectedBody)));
    const mapper = createProviderObservationMapperRegistryFromManifest().resolve(descriptor);
    let collectibleValidated = 0;
    let canonicalMissingDisplayNameRejected = 0;
    for (const [position, outcome] of inspected.outcomes.entries()) {
      if (outcome.status !== "valid") refuse("COURTYARD_CANARY_NORMALIZATION_REJECTED");
      const context = { organizationId: pins.organizationId, providerId: input.providerId, ...descriptor, observation: outcome.observation };
      const mapped = mapper.map(context);
      if (mapped.status !== "mapped") refuse("COURTYARD_CANARY_MAPPING_REJECTED");
      providerSourceCanonicalProjectionsForValidatedMapping(mapped, context);
      const raw = dataforrestEventRecordV1Schema.parse(wire.records[position]);
      if (mapped.candidate.candidateKind !== "catalog_asset" || raw.platform !== "courtyard" || raw.stream !== "catalog" || raw.entity !== "card" ||
        mapped.candidate.identity.providerRecordId !== raw.record_id) refuse("COURTYARD_CANARY_COLLECTIBLE_REJECTED");
      let draft: ReturnType<typeof collectibleDraft>;
      try { draft = collectibleDraft(mapped.candidate); }
      catch (error) {
        if (!isReviewedCourtyardMissingNameRejection({ error, nativeData: raw.data,
          normalizedFacts: outcome.observation.providerFacts, candidateDisplayName: mapped.candidate.displayName })) throw error;
        canonicalMissingDisplayNameRejected += 1;
        continue;
      }
      // Never absorb a downstream canonical-validation or projection failure into the missing-name allowance.
      const validated = validateProviderMixedPageRecord({ ...draft, position, providerId: input.providerId }, { position, providerId: input.providerId });
      if (validated.disposition === "quarantine") refuse("COURTYARD_CANARY_COLLECTIBLE_REJECTED");
      collectibleValidated += 1;
    }
    return courtyardCanarySchema.parse({ checkKind: "courtyard_untrusted_parser_mapper_inspection", adapterKey: pins.nextAdapter,
      providerId: input.providerId, nextConfigId: input.nextConfigId, savedCursorHash: pins.cursorHash,
      opaqueValueHash: handoffDigest(input.opaqueCursor), status: 200, recordCount: 100, adapterInvalid: 0, mapperQuarantined: 0,
      collectibleValidated, canonicalMissingDisplayNameRejected, canonicalQuarantineClass: "missing_display_name",
      responseBytes: response.responseBytes, durationMilliseconds: response.durationMilliseconds, checkedAt: new Date().toISOString() });
  } catch { return refuse("COURTYARD_CANARY_ADMISSION_FAILED"); }
  finally { response.protectedBody.fill(0); }
}
