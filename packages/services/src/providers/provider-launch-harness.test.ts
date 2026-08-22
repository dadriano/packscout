import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  emptyNormalizedProviderFacts,
  launchProviderKeys,
} from "@packscout/contracts";
import {
  ProductionProviderObservationMapperRegistry,
  ProviderObservationMapperRegistryError,
} from "../provider-observation-mapper-registry.ts";
import {
  canonicalProviderIdentityKey,
  decideCanonicalProjection,
  decideEvInputProjection,
  reconcileCanonicalRelationships,
} from "../provider-observation-projection.ts";
import {
  clutchpacksProviderObservationMapper,
} from "./clutchpacks/mapper.ts";
import { createProviderObservationMapperRegistryFromManifest, providerMapperManifest } from "./provider-mapper-manifest.ts";
import {
  mapperInput,
  packFacts,
  packObservation,
  pullObservation,
  tradeObservation,
} from "./provider-observation-mapper.test-support.ts";

const registry = createProviderObservationMapperRegistryFromManifest();

function mapped(input: Parameters<typeof registry.map>[0]) {
  const outcome = registry.map(input);
  assert.equal(outcome.status, "mapped");
  if (outcome.status !== "mapped") throw new Error("expected mapped outcome");
  return outcome;
}

test("production composition has exactly the four compatible launch mappers", () => {
  assert.deepEqual(
    providerMapperManifest.map(({ descriptor }) => descriptor.provider),
    launchProviderKeys,
  );
  assert.equal(
    new Set(
      providerMapperManifest.map(
        ({ descriptor }) => descriptor.mapperKey + "@" + descriptor.mapperVersion,
      ),
    ).size,
    4,
  );
  assert.equal(
    providerMapperManifest.some(
      ({ descriptor }) =>
        descriptor.mapperKey === DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    ),
    false,
  );
});

test("registry fails closed for missing, extra, duplicate, and descriptor-mismatched implementations", () => {
  assert.throws(
    () => new ProductionProviderObservationMapperRegistry(providerMapperManifest.slice(1)),
    (error) =>
      error instanceof ProviderObservationMapperRegistryError &&
      error.code === "missing_mapper_registration",
  );
  assert.throws(
    () =>
      new ProductionProviderObservationMapperRegistry([
        ...providerMapperManifest,
        clutchpacksProviderObservationMapper,
      ]),
    (error) =>
      error instanceof ProviderObservationMapperRegistryError &&
      error.code === "duplicate_mapper_registration",
  );
  const extra = {
    descriptor: {
      ...clutchpacksProviderObservationMapper.descriptor,
      mapperKey: "beezie-provider-observation",
    },
    map: clutchpacksProviderObservationMapper.map,
  };
  assert.throws(
    () => new ProductionProviderObservationMapperRegistry([...providerMapperManifest, extra]),
    (error) =>
      error instanceof ProviderObservationMapperRegistryError &&
      error.code === "extra_mapper_registration",
  );
  const mismatched = {
    descriptor: {
      ...clutchpacksProviderObservationMapper.descriptor,
      provider: "courtyard" as const,
    },
    map: clutchpacksProviderObservationMapper.map,
  };
  assert.throws(
    () =>
      new ProductionProviderObservationMapperRegistry([
        ...providerMapperManifest.slice(0, 3),
        mismatched,
      ]),
    (error) =>
      error instanceof ProviderObservationMapperRegistryError &&
      error.code === "incompatible_mapper_registration",
  );
});

test("mapper resolution uses only the immutable mapper compatibility tuple", () => {
  const valid = mapperInput("courtyard", packObservation());
  assert.equal(registry.resolve(valid).descriptor.provider, "courtyard");
  assert.equal("sourceTypeKey" in valid, false);
  assert.equal("adapterKey" in valid, false);
  assert.equal("cursor" in valid, false);
  assert.equal("endpoint" in valid, false);
  assert.equal("credentials" in valid, false);

  assert.throws(
    () => registry.resolve({ ...valid, mapperVersion: "2" }),
    (error) =>
      error instanceof ProviderObservationMapperRegistryError &&
      error.code === "unknown_mapper_registration",
  );
  assert.throws(
    () => registry.resolve({ ...valid, provider: "phygitals" }),
    (error) =>
      error instanceof ProviderObservationMapperRegistryError &&
      error.code === "incompatible_mapper_registration",
  );
  assert.throws(
    () => registry.resolve({ ...valid, identityNamespaceKey: "foreign" }),
    (error) =>
      error instanceof ProviderObservationMapperRegistryError &&
      error.code === "incompatible_mapper_registration",
  );
});

test("generic mapper and projection code contain no transport or launch-provider branch", () => {
  for (const path of [
    new URL("../provider-observation-mapper.ts", import.meta.url),
    new URL("../provider-observation-projection.ts", import.meta.url),
  ]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(
      source,
      /dataforr(?:est|est)|sourceTypeKey|adapterKey|endpoint|credential/iu,
    );
    assert.doesNotMatch(
      source,
      /courtyard|collector_crypt|phygitals|clutchpacks/iu,
    );
  }
});

test("a platform mismatch is quarantined locally and never redirected", () => {
  const outcome = clutchpacksProviderObservationMapper.map(
    mapperInput("courtyard", packObservation(), {
      mapperKey: clutchpacksProviderObservationMapper.descriptor.mapperKey,
      mapperVersion: clutchpacksProviderObservationMapper.descriptor.mapperVersion,
      normalizedContractVersion:
        clutchpacksProviderObservationMapper.descriptor.normalizedContractVersion,
      identityNamespaceKey:
        clutchpacksProviderObservationMapper.descriptor.identityNamespaceKey,
    }),
  );
  assert.deepEqual(
    outcome.status === "quarantined"
      ? [outcome.status, outcome.reasonCode]
      : [outcome.status, null],
    ["quarantined", "platform_mismatch"],
  );
});

test("catalog lifecycle is deterministic for replay, revision, late history, and reappearance", () => {
  const available = mapped(
    mapperInput("courtyard", packObservation({ availability: "available" })),
  ).candidate;
  const first = decideCanonicalProjection({
    candidate: available,
    existingBinding: null,
    revisions: [],
  });
  assert.equal(first.disposition, "inserted");
  assert.equal(first.becomesCurrent, true);

  const replay = decideCanonicalProjection({
    candidate: available,
    existingBinding: {
      recordIdScopeKey: available.recordIdScopeKey,
      canonicalKind: available.candidateKind,
    },
    revisions: [
      {
        contentFingerprint: first.contentFingerprint,
        effectiveAt: available.effectiveAt,
      },
    ],
  });
  assert.equal(replay.disposition, "duplicate");

  const sameContentAtLaterTime = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        availability: "available",
        effectiveAt: "2026-08-21T12:00:00.000Z",
      }),
    ),
  ).candidate;
  const effectiveTimeOnly = decideCanonicalProjection({
    candidate: sameContentAtLaterTime,
    existingBinding: {
      recordIdScopeKey: available.recordIdScopeKey,
      canonicalKind: available.candidateKind,
    },
    revisions: [
      {
        contentFingerprint: first.contentFingerprint,
        effectiveAt: available.effectiveAt,
      },
    ],
  });
  assert.equal(effectiveTimeOnly.contentFingerprint, first.contentFingerprint);
  assert.equal(effectiveTimeOnly.disposition, "duplicate");

  const unavailable = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        availability: "unavailable",
        effectiveAt: "2026-08-21T12:00:00.000Z",
      }),
    ),
  ).candidate;
  const unavailableRevision = decideCanonicalProjection({
    candidate: unavailable,
    existingBinding: {
      recordIdScopeKey: available.recordIdScopeKey,
      canonicalKind: available.candidateKind,
    },
    revisions: [
      {
        contentFingerprint: first.contentFingerprint,
        effectiveAt: available.effectiveAt,
      },
    ],
  });
  assert.equal(unavailableRevision.disposition, "revised");
  assert.equal(unavailableRevision.becomesCurrent, true);

  const reappeared = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        availability: "available",
        effectiveAt: "2026-08-22T12:00:00.000Z",
      }),
    ),
  ).candidate;
  const reappearanceRevision = decideCanonicalProjection({
    candidate: reappeared,
    existingBinding: {
      recordIdScopeKey: available.recordIdScopeKey,
      canonicalKind: available.candidateKind,
    },
    revisions: [
      {
        contentFingerprint: first.contentFingerprint,
        effectiveAt: available.effectiveAt,
      },
      {
        contentFingerprint: unavailableRevision.contentFingerprint,
        effectiveAt: unavailable.effectiveAt,
      },
    ],
  });
  assert.equal(reappearanceRevision.contentFingerprint, first.contentFingerprint);
  assert.equal(reappearanceRevision.disposition, "revised");
  assert.equal(reappearanceRevision.becomesCurrent, true);

  const late = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        availability: "unknown",
        effectiveAt: "2026-08-10T12:00:00.000Z",
      }),
    ),
  ).candidate;
  const lateRevision = decideCanonicalProjection({
    candidate: late,
    existingBinding: {
      recordIdScopeKey: available.recordIdScopeKey,
      canonicalKind: available.candidateKind,
    },
    revisions: [
      {
        contentFingerprint: first.contentFingerprint,
        effectiveAt: available.effectiveAt,
      },
      {
        contentFingerprint: unavailableRevision.contentFingerprint,
        effectiveAt: unavailable.effectiveAt,
      },
      {
        contentFingerprint: reappearanceRevision.contentFingerprint,
        effectiveAt: reappeared.effectiveAt,
      },
    ],
  });
  assert.equal(lateRevision.disposition, "revised");
  assert.equal(lateRevision.becomesCurrent, false);
});

test("same-time catalog ordering is stable and immutable records duplicate by content", () => {
  const packA = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        providerFacts: packFacts({
          displayName: { state: "present", value: "Pack A" },
        }),
      }),
    ),
  ).candidate;
  const packB = mapped(
    mapperInput(
      "courtyard",
      packObservation({
        providerFacts: packFacts({
          displayName: { state: "present", value: "Pack B" },
        }),
      }),
    ),
  ).candidate;
  const a = decideCanonicalProjection({ candidate: packA, existingBinding: null, revisions: [] });
  const bAfterA = decideCanonicalProjection({
    candidate: packB,
    existingBinding: {
      recordIdScopeKey: packA.recordIdScopeKey,
      canonicalKind: packA.candidateKind,
    },
    revisions: [{ contentFingerprint: a.contentFingerprint, effectiveAt: packA.effectiveAt }],
  });
  assert.equal(
    bAfterA.becomesCurrent,
    bAfterA.contentFingerprint > a.contentFingerprint,
  );

  for (const observation of [pullObservation(), tradeObservation()]) {
    const original = mapped(mapperInput("phygitals", observation)).candidate;
    const inserted = decideCanonicalProjection({
      candidate: original,
      existingBinding: null,
      revisions: [],
    });
    const effectiveTimeOnlyObservation =
      observation.kind === "pull"
        ? pullObservation({ effectiveAt: "2026-08-20T12:00:02.000Z" })
        : tradeObservation({ effectiveAt: "2026-08-20T12:00:02.000Z" });
    const effectiveTimeOnlyCandidate = mapped(
      mapperInput("phygitals", effectiveTimeOnlyObservation),
    ).candidate;
    const duplicate = decideCanonicalProjection({
      candidate: effectiveTimeOnlyCandidate,
      existingBinding: {
        recordIdScopeKey: original.recordIdScopeKey,
        canonicalKind: original.candidateKind,
      },
      revisions: [
        {
          contentFingerprint: inserted.contentFingerprint,
          effectiveAt: original.effectiveAt,
        },
      ],
    });
    assert.equal(duplicate.contentFingerprint, inserted.contentFingerprint);
    assert.equal(duplicate.disposition, "duplicate");

    const changedObservation = observation.kind === "pull"
      ? pullObservation({
          providerFacts: {
            ...emptyNormalizedProviderFacts("pull"),
            displayName: { state: "present", value: "Changed pull" },
          },
        })
      : tradeObservation({ eventType: "buyback" });
    const changed = mapped(mapperInput("phygitals", changedObservation)).candidate;
    const conflict = decideCanonicalProjection({
      candidate: changed,
      existingBinding: {
        recordIdScopeKey: original.recordIdScopeKey,
        canonicalKind: original.candidateKind,
      },
      revisions: [
        {
          contentFingerprint: inserted.contentFingerprint,
          effectiveAt: original.effectiveAt,
        },
      ],
    });
    assert.deepEqual(
      conflict.disposition === "quarantined"
        ? [conflict.disposition, conflict.reasonCode]
        : [conflict.disposition, null],
      ["quarantined", "immutable_content_conflict"],
    );
  }
});

test("identity-kind conflicts quarantine while separate evidenced scopes remain distinct", () => {
  const pack = mapped(mapperInput("courtyard", packObservation())).candidate;
  const conflict = decideCanonicalProjection({
    candidate: pack,
    existingBinding: {
      recordIdScopeKey: "catalog-card-v1",
      canonicalKind: "catalog_asset",
    },
    revisions: [],
  });
  assert.deepEqual(
    conflict.disposition === "quarantined"
      ? [conflict.disposition, conflict.reasonCode]
      : [conflict.disposition, null],
    ["quarantined", "identity_kind_conflict"],
  );
});

test("unresolved scope-qualified relationships reconcile idempotently", () => {
  const pull = mapped(mapperInput("collector_crypt", pullObservation())).candidate;
  assert.equal(pull.candidateKind, "pull");
  if (pull.candidateKind !== "pull") return;
  const none = reconcileCanonicalRelationships({
    source: pull.identity,
    relationships: pull.relationships,
    knownCanonicalIdentityKeys: new Set(),
  });
  assert.equal(none.resolved.length, 0);
  assert.equal(none.unresolved.length, 2);
  assert.deepEqual([none.resolvedCount, none.unresolvedCount], [0, 2]);

  const packTarget = {
    ...pull.identity,
    canonicalKind: "pack" as const,
    providerRecordId: "shared-raw-id",
  };
  const cardTarget = {
    ...pull.identity,
    canonicalKind: "catalog_asset" as const,
    providerRecordId: "shared-raw-id",
  };
  const known = new Set([
    canonicalProviderIdentityKey(packTarget),
    canonicalProviderIdentityKey(cardTarget),
  ]);
  const reconciled = reconcileCanonicalRelationships({
    source: pull.identity,
    relationships: none.unresolved,
    knownCanonicalIdentityKeys: known,
  });
  assert.equal(reconciled.resolved.length, 2);
  assert.equal(reconciled.unresolved.length, 0);
  assert.deepEqual(
    [reconciled.resolvedCount, reconciled.unresolvedCount],
    [2, 0],
  );
  assert.deepEqual(
    reconcileCanonicalRelationships({
      source: pull.identity,
      relationships: none.unresolved,
      knownCanonicalIdentityKeys: known,
    }),
    reconciled,
  );
});

test("complete EV evidence emits a pack recomputation candidate; incomplete evidence does not quarantine", () => {
  const complete = mapped(
    mapperInput(
      "clutchpacks",
      packObservation({
        providerFacts: packFacts({
          price: { state: "present", value: { amount: 100, currency: "USD" } },
          providerReportedEv: {
            state: "present",
            value: { amount: 92, currency: "USD" },
          },
          evInput: {
            state: "present",
            value: {
              approved: true,
              currency: "USD",
              unitBasis: "per_pack",
              drawCount: 1,
              buybackPercent: 85,
              totalQuantity: 10,
              buckets: [
                {
                  bucketId: "base",
                  label: "Base",
                  probability: 0.9,
                  quantity: 9,
                  lowerValue: 20,
                  upperValue: 40,
                },
                {
                  bucketId: "chase",
                  label: "Chase",
                  probability: 0.1,
                  quantity: 1,
                  lowerValue: 500,
                  upperValue: 500,
                },
              ],
            },
          },
        }),
      }),
    ),
  );
  assert.equal(complete.evInputStatus, "ready");
  assert.equal(complete.evInputCandidate?.candidateKind, "ev_input");
  assert.equal(complete.evInputCandidate?.affectedPack.canonicalKind, "pack");
  assert.deepEqual(complete.evRecomputationImpact, {
    kind: "pack",
    affectedPack: complete.candidate.identity,
  });
  assert.equal(
    complete.candidate.candidateKind === "pack"
      ? complete.candidate.providerReportedEv?.amount
      : null,
    92,
  );
  const insertedEv = decideEvInputProjection({
    candidate: complete.evInputCandidate!,
    revisions: [],
  });
  assert.equal(insertedEv.disposition, "inserted");
  assert.equal(
    decideEvInputProjection({
      candidate: complete.evInputCandidate!,
      revisions: [
        {
          contentFingerprint: insertedEv.contentFingerprint,
          effectiveAt: complete.evInputCandidate!.effectiveAt,
        },
      ],
    }).disposition,
    "duplicate",
  );

  const incomplete = mapped(
    mapperInput(
      "clutchpacks",
      packObservation({
        providerFacts: packFacts({
          evInput: {
            state: "present",
            value: {
              approved: true,
              currency: "USD",
              unitBasis: "per_pack",
              drawCount: 1,
              buybackPercent: null,
              totalQuantity: 1,
              buckets: [],
            },
          },
        }),
      }),
    ),
  );
  assert.equal(incomplete.evInputStatus, "unavailable");
  assert.equal(incomplete.evInputCandidate, null);
  assert.equal(incomplete.status, "mapped");
  assert.deepEqual(incomplete.warnings, [
    { code: "ev_input_unavailable", fieldPath: "providerFacts.evInput" },
  ]);
});
