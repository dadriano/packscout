import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  normalizedProviderObservationPageSchema,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import { ProviderSourcePagePlanner } from "./provider-source-page-planner.ts";
import { createProviderObservationMapperRegistryFromManifest } from "./providers/provider-mapper-manifest.ts";
import {
  descriptorFor,
  packObservation,
  pullObservation,
  tradeObservation,
} from "./providers/provider-observation-mapper.test-support.ts";

function mixedPage() {
  return normalizedProviderObservationPageSchema.parse({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider: "courtyard",
    outcomes: [
      { status: "valid", recordIndex: 0, observation: packObservation() },
      {
        status: "invalid",
        recordIndex: 1,
        reasonCode: "missing_identity",
        fieldPaths: ["id"],
        protectedNativeEvidenceRef: "evidence:invalid-1",
      },
      { status: "valid", recordIndex: 2, observation: pullObservation() },
      { status: "valid", recordIndex: 3, observation: tradeObservation() },
    ],
    nextCursor: {
      sourceInstanceId: "source-courtyard",
      sourceRevisionId: "revision-courtyard",
      sourceTypeKey: "dataforrest-events-v1",
      adapterVersion: "dataforrest-events-v1",
      cursorCodecKey: "dataforrest-events-cursor-v1",
      cursorGeneration: 1,
      value: "cursor-b",
    },
    continuation: { kind: "continue" },
    measurements: {
      durationMilliseconds: 12,
      responseBytes: 512,
      recordCount: 4,
    },
    diagnostics: [],
  });
}

test("normalized mixed page maps valid siblings and retains adapter-invalid outcome", () => {
  const descriptor = descriptorFor("courtyard");
  const planner = new ProviderSourcePagePlanner(
    createProviderObservationMapperRegistryFromManifest(),
  );
  const result = planner.plan({
    organizationId: "organization-1",
    providerId: "provider-1",
    provider: "courtyard",
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey:
      providerIdentityNamespaceByLaunchProvider.courtyard,
    page: mixedPage(),
  });

  assert.deepEqual(result.counts, {
    catalog: 1,
    pulls: 1,
    trades: 1,
    adapterInvalid: 1,
    mapperQuarantined: 0,
    warnings: 0,
  });
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.kind),
    ["semantic", "adapter_invalid", "semantic", "semantic"],
  );
  const pack = result.outcomes[0];
  assert.equal(pack?.kind, "semantic");
  if (pack?.kind !== "semantic" || pack.mapping.status !== "mapped") {
    assert.fail("pack should map");
  }
  assert.equal(pack.mapping.projections[0]?.recordKind, "pack");
  assert.match(pack.normalizedContentHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    JSON.stringify(pack.mapping.projections).includes("protectedNativeEvidence"),
    false,
  );
});

test("mapper exceptions quarantine only their record and never receive native evidence", () => {
  const descriptor = descriptorFor("courtyard");
  const seen: unknown[] = [];
  const planner = new ProviderSourcePagePlanner({
    resolve() {
      return {
        descriptor,
        map(input) {
          seen.push(input);
          if (input.observation.kind === "pull") throw new Error("native secret");
          return createProviderObservationMapperRegistryFromManifest().map(input);
        },
      };
    },
  });
  const result = planner.plan({
    organizationId: "organization-1",
    providerId: "provider-1",
    provider: "courtyard",
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey:
      providerIdentityNamespaceByLaunchProvider.courtyard,
    page: mixedPage(),
  });

  const pull = result.outcomes[2];
  assert.equal(pull?.kind, "semantic");
  assert.deepEqual(
    pull?.kind === "semantic" ? pull.mapping : null,
    { status: "quarantined", reasonCode: "mapping_failure" },
  );
  assert.equal(result.counts.mapperQuarantined, 1);
  assert.equal(JSON.stringify(seen).includes("evidence:invalid-1"), false);
});

test("malformed mapper returns quarantine only their record", () => {
  const descriptor = descriptorFor("courtyard");
  const production = createProviderObservationMapperRegistryFromManifest();
  const planner = new ProviderSourcePagePlanner({
    resolve() {
      return {
        descriptor,
        map(input) {
          return input.observation.kind === "pull"
            ? undefined as never
            : production.map(input);
        },
      };
    },
  });
  const result = planner.plan({
    organizationId: "organization-1",
    providerId: "provider-1",
    provider: "courtyard",
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    page: mixedPage(),
  });

  assert.equal(result.counts.mapperQuarantined, 1);
  assert.deepEqual(
    result.outcomes.map((outcome) =>
      outcome.kind === "semantic" ? outcome.mapping.status : outcome.kind
    ),
    ["mapped", "adapter_invalid", "quarantined", "mapped"],
  );
});

test("a malformed mapped union is record-local even when its candidate is otherwise valid", () => {
  const descriptor = descriptorFor("courtyard");
  const production = createProviderObservationMapperRegistryFromManifest();
  const planner = new ProviderSourcePagePlanner({
    resolve() {
      return {
        descriptor,
        map(input) {
          const mapped = production.map(input);
          return input.observation.kind === "pull" && mapped.status === "mapped"
            ? { ...mapped, evInputStatus: "garbage" } as never
            : mapped;
        },
      };
    },
  });
  const result = planner.plan({
    organizationId: "organization-1",
    providerId: "provider-1",
    provider: "courtyard",
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    page: mixedPage(),
  });

  assert.equal(result.counts.mapperQuarantined, 1);
  const pull = result.outcomes[2];
  assert.deepEqual(
    pull?.kind === "semantic" ? pull.mapping : null,
    { status: "quarantined", reasonCode: "mapping_failure" },
  );
  assert.equal(result.outcomes[0]?.kind, "semantic");
  assert.equal(result.outcomes[3]?.kind, "semantic");
});

test("malformed candidate kind and nested identity are record-local", () => {
  const descriptor = descriptorFor("courtyard");
  const production = createProviderObservationMapperRegistryFromManifest();
  const planner = new ProviderSourcePagePlanner({
    resolve() {
      return {
        descriptor,
        map(input) {
          const mapped = production.map(input);
          if (mapped.status !== "mapped") return mapped;
          if (input.observation.kind === "pull") {
            return {
              ...mapped,
              candidate: { ...mapped.candidate, candidateKind: "bogus" },
            } as never;
          }
          if (input.observation.kind === "trade") {
            return {
              ...mapped,
              candidate: {
                ...mapped.candidate,
                identity: { ...mapped.candidate.identity, provider: undefined },
              },
            } as never;
          }
          return mapped;
        },
      };
    },
  });

  const result = planner.plan({
    organizationId: "organization-1",
    providerId: "provider-1",
    provider: "courtyard",
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    page: mixedPage(),
  });

  assert.equal(result.counts.mapperQuarantined, 2);
  assert.deepEqual(
    result.outcomes.map((outcome) =>
      outcome.kind === "semantic" ? outcome.mapping.status : outcome.kind
    ),
    ["mapped", "adapter_invalid", "quarantined", "quarantined"],
  );
});

test("mapper relationship targets remain bound to the normalized observation", () => {
  const descriptor = descriptorFor("courtyard");
  const production = createProviderObservationMapperRegistryFromManifest();
  const planner = new ProviderSourcePagePlanner({
    resolve() {
      return {
        descriptor,
        map(input) {
          const mapped = production.map(input);
          if (input.observation.kind !== "trade" || mapped.status !== "mapped") {
            return mapped;
          }
          return {
            ...mapped,
            candidate: {
              ...mapped.candidate,
              relationships: [{
                relationship: "pack",
                targetRecordIdScopeKey: "catalog-pack-v1",
                targetCanonicalKind: "pack",
                targetProviderRecordId: "wrong-pack",
              }],
            },
          } as never;
        },
      };
    },
  });

  const result = planner.plan({
    organizationId: "organization-1",
    providerId: "provider-1",
    provider: "courtyard",
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    page: mixedPage(),
  });

  const trade = result.outcomes[3];
  assert.deepEqual(
    trade?.kind === "semantic" ? trade.mapping : null,
    { status: "quarantined", reasonCode: "mapping_failure" },
  );
  assert.equal(result.outcomes[0]?.kind, "semantic");
  assert.equal(result.outcomes[2]?.kind, "semantic");
});

test("a mapper cannot mutate a normalized observation after semantic binding", () => {
  const descriptor = descriptorFor("courtyard");
  const production = createProviderObservationMapperRegistryFromManifest();
  const planner = new ProviderSourcePagePlanner({
    resolve() {
      return {
        descriptor,
        map(input) {
          if (input.observation.kind === "pull") {
            (input.observation.providerRecordIdentity as {
              providerRecordId: string;
            }).providerRecordId = "mutated-after-semantic-hash";
          }
          return production.map(input);
        },
      };
    },
  });

  const result = planner.plan({
    organizationId: "organization-1",
    providerId: "provider-1",
    provider: "courtyard",
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    page: mixedPage(),
  });

  assert.equal(result.counts.mapperQuarantined, 1);
  const pull = result.outcomes[2];
  assert.deepEqual(
    pull?.kind === "semantic" ? pull.mapping : null,
    { status: "quarantined", reasonCode: "mapping_failure" },
  );
  assert.equal(
    pull?.kind === "semantic"
      ? pull.observation.providerRecordIdentity.providerRecordId
      : null,
    "pull-1",
  );
  assert.equal(result.outcomes[3]?.kind, "semantic");
});

test("mapper descriptor and normalized page pins are exact", () => {
  const descriptor = descriptorFor("courtyard");
  const planner = new ProviderSourcePagePlanner(
    createProviderObservationMapperRegistryFromManifest(),
  );
  assert.throws(
    () => planner.plan({
      organizationId: "organization-1",
      providerId: "provider-1",
      provider: "courtyard",
      mapperKey: descriptor.mapperKey,
      mapperVersion: "wrong-version",
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      identityNamespaceKey:
        providerIdentityNamespaceByLaunchProvider.courtyard,
      page: mixedPage(),
    }),
    /mapper_descriptor_mismatch/u,
  );
  assert.throws(
    () => planner.plan({
      organizationId: "organization-1",
      providerId: "provider-1",
      provider: "phygitals",
      mapperKey: descriptor.mapperKey,
      mapperVersion: descriptor.mapperVersion,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      identityNamespaceKey:
        providerIdentityNamespaceByLaunchProvider.phygitals,
      page: mixedPage(),
    }),
    /normalized_page_mismatch/u,
  );
});
