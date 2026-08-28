import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  normalizedProviderObservationPageSchema,
  type LaunchProviderKey,
} from "@packscout/contracts";
import { interpretDataforrestPage } from
  "./dataforrest-events-page-interpreter.ts";
import { ProviderSourcePagePlanner } from
  "./provider-source-page-planner.ts";
import { createProviderObservationMapperRegistryFromManifest } from
  "./providers/provider-mapper-manifest.ts";
import {
  SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
  type PageReadInterpretationContext,
  type SuccessfulSourceAdapterRequest,
} from "./source-adapter.ts";
import { launchSourceMapperDescriptors } from
  "./source-mapper-descriptors.ts";

const observedAt = "2026-08-25T12:00:00.000Z";

function interpretationContext(
  provider: LaunchProviderKey,
): PageReadInterpretationContext {
  const declaration = dataforrestEventsV1SourceAdapterManifest
    .supportedProviders.find((candidate) => candidate.provider === provider);
  if (declaration === undefined) {
    throw new Error("test_fixture.provider_declaration_missing");
  }
  return {
    operationKind: "page_read",
    organizationId: "organization-1",
    sourceTypeKey: dataforrestEventsV1SourceAdapterManifest.sourceTypeKey,
    adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    connectionProfileId: "profile-1",
    connectionProfileRevisionId: "profile-revision-1",
    bounds: dataforrestEventsV1SourceAdapterManifest.requestBounds,
    provider,
    sourceInstanceId: `source-${provider}`,
    sourceRevisionId: `source-revision-${provider}`,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: declaration.identityNamespaceKey,
    recordIdScopes: declaration.recordIdScopes,
    sourceConfiguration: { platform: provider },
    requestedCursor: {
      sourceInstanceId: `source-${provider}`,
      sourceRevisionId: `source-revision-${provider}`,
      sourceTypeKey: dataforrestEventsV1SourceAdapterManifest.sourceTypeKey,
      adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      cursorCodecKey: dataforrestEventsV1SourceAdapterManifest.cursorCodecKey,
      cursorGeneration: 1,
      value: null,
    },
    pageLimit: dataforrestEventsV1SourceAdapterManifest.requestBounds.pageLimit,
    pageNumber: 1,
  };
}

function capturedPage(value: unknown): SuccessfulSourceAdapterRequest {
  const protectedRawResponse = new TextEncoder().encode(JSON.stringify(value));
  return {
    ok: true,
    value: {
      captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
      protectedRawResponse,
      protectedRawResponseSha256: createHash("sha256")
        .update(protectedRawResponse)
        .digest("hex"),
    },
    measurements: {
      durationMilliseconds: 1,
      responseBytes: protectedRawResponse.byteLength,
    },
    diagnostics: [],
  } as unknown as SuccessfulSourceAdapterRequest;
}

test("the sole v1 adapter projects partial pulls without fabricating a relationship", async (t) => {
  const fixtures = [
    {
      name: "Collector Crypt pack-only pull",
      provider: "collector_crypt" as const,
      packId: "pack-1",
      cardId: null,
      expectedRelationship: {
        relationship: "pack",
        targetRecordIdScopeKey: "catalog-pack-v1",
        targetCanonicalKind: "pack",
        targetProviderRecordId: "pack-1",
      },
    },
    {
      name: "ClutchPacks card-only pull",
      provider: "clutchpacks" as const,
      packId: null,
      cardId: "card-1",
      expectedRelationship: {
        relationship: "card",
        targetRecordIdScopeKey: "catalog-card-v1",
        targetCanonicalKind: "catalog_asset",
        targetProviderRecordId: "card-1",
      },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const context = interpretationContext(fixture.provider);
      const request = capturedPage({
        records: [{
          stream: "pulls",
          platform: fixture.provider,
          record_id: `pull-${fixture.provider}`,
          occurred_at: observedAt,
          collected_at: observedAt,
          pack_id: fixture.packId,
          card_id: fixture.cardId,
          data: {},
        }],
        next_cursor: `next-${fixture.provider}`,
        poll_after_seconds: 0,
      });
      const interpreted = await interpretDataforrestPage(context, request);
      assert.equal(interpreted.ok, true);
      if (!interpreted.ok) assert.fail("expected adapter-v1 page interpretation");

      const page = normalizedProviderObservationPageSchema.parse({
        ...interpreted.value.normalizedPage,
        measurements: {
          ...request.measurements,
          recordCount: 1,
        },
        diagnostics: interpreted.diagnostics,
      });
      const descriptor = launchSourceMapperDescriptors.find((candidate) =>
        candidate.provider === fixture.provider &&
        candidate.normalizedContractVersion ===
          PROVIDER_OBSERVATION_CONTRACT_VERSION
      );
      if (descriptor === undefined) {
        assert.fail("expected the observation-v1 mapper descriptor");
      }
      const plan = new ProviderSourcePagePlanner(
        createProviderObservationMapperRegistryFromManifest(),
      ).plan({
        organizationId: "organization-1",
        providerId: `provider-${fixture.provider}`,
        provider: fixture.provider,
        mapperKey: descriptor.mapperKey,
        mapperVersion: descriptor.mapperVersion,
        normalizedContractVersion: descriptor.normalizedContractVersion,
        identityNamespaceKey: descriptor.identityNamespaceKey,
        page,
      });

      assert.equal(plan.counts.pulls, 1);
      assert.equal(plan.counts.adapterInvalid, 0);
      assert.equal(plan.counts.mapperQuarantined, 0);
      const outcome = plan.outcomes[0];
      assert.equal(outcome?.kind, "semantic");
      if (outcome?.kind !== "semantic") assert.fail("expected semantic pull");
      assert.equal(outcome.mapping.status, "mapped");
      if (outcome.mapping.status !== "mapped") assert.fail("expected mapped pull");
      assert.equal(outcome.mapping.projections.length, 1);
      const projection = outcome.mapping.projections[0];
      assert.equal(projection?.recordKind, "pull");
      assert.deepEqual(projection?.relationships, [fixture.expectedRelationship]);
      assert.equal(
        projection?.relationships.filter(({ relationship }) =>
          relationship === "pack"
        ).length,
        fixture.packId === null ? 0 : 1,
      );
      assert.equal(
        projection?.relationships.filter(({ relationship }) =>
          relationship === "card"
        ).length,
        fixture.cardId === null ? 0 : 1,
      );
    });
  }
});
