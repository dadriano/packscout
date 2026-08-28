import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { TASK010_PROVIDER_IDENTITIES } from "./provider-source-task010-safety.mjs";

const {
  assertTask010ActiveConnectionRevisionPins,
  assertTask010ConnectionRevisionPins,
  assertTask010ProviderSourceRevisionPins,
  parseTask010CapacityArtifact,
} = await tsImport("./provider-source-task010-runtime.mts", import.meta.url);

const mapperPins = Object.freeze({
  courtyard: Object.freeze({
    mapperKey: "courtyard-provider-observation",
    identityNamespaceKey: "dataforrest-courtyard-records-v1",
  }),
  collector_crypt: Object.freeze({
    mapperKey: "collector-crypt-provider-observation",
    identityNamespaceKey: "dataforrest-collector_crypt-records-v1",
  }),
  phygitals: Object.freeze({
    mapperKey: "phygitals-provider-observation",
    identityNamespaceKey: "dataforrest-phygitals-records-v1",
  }),
  clutchpacks: Object.freeze({
    mapperKey: "clutchpacks-provider-observation",
    identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
  }),
});

const currentSourcePins = TASK010_PROVIDER_IDENTITIES.map((provider) => ({
  providerId: provider.id,
  sourceTypeKey: "dataforrest-events-v1",
  sourceAdapterVersion: "dataforrest-events-adapter-v1",
  normalizedContractVersion: "packscout.provider-observation.v1",
  mapperKey: mapperPins[provider.platformKey].mapperKey,
  mapperVersion: "1",
  identityNamespaceKey: mapperPins[provider.platformKey].identityNamespaceKey,
}));

function hasSafetyCode(code) {
  return (error) =>
    error !== null &&
    typeof error === "object" &&
    error.name === "Task010SafetyError" &&
    error.code === code;
}

test("Task010 topology accepts only the current active connection adapter", () => {
  assert.doesNotThrow(() =>
    assertTask010ActiveConnectionRevisionPins([
      { sourceAdapterVersion: "dataforrest-events-adapter-v1" },
    ]),
  );
  for (const revisions of [
    [],
    [{ sourceAdapterVersion: "dataforrest-events-adapter-v2" }],
    [{ sourceAdapterVersion: "dataforrest-events-adapter-v3" }],
    [
      { sourceAdapterVersion: "dataforrest-events-adapter-v1" },
      { sourceAdapterVersion: "dataforrest-events-adapter-v2" },
    ],
  ]) {
    assert.throws(
      () => assertTask010ActiveConnectionRevisionPins(revisions),
      hasSafetyCode("SOURCE_CONNECTION_NOT_BACKFILL_READY"),
    );
  }
});

test("Task010 topology rejects historical connection revision contamination", () => {
  assert.doesNotThrow(() => assertTask010ConnectionRevisionPins([]));
  assert.doesNotThrow(() =>
    assertTask010ConnectionRevisionPins([
      { sourceAdapterVersion: "dataforrest-events-adapter-v1" },
      { sourceAdapterVersion: "dataforrest-events-adapter-v1" },
    ]),
  );
  for (const revisions of [
    [{ sourceAdapterVersion: "dataforrest-events-adapter-v2" }],
    [{ sourceAdapterVersion: "dataforrest-events-adapter-v3" }],
    [
      { sourceAdapterVersion: "dataforrest-events-adapter-v1" },
      { sourceAdapterVersion: "dataforrest-events-adapter-v2" },
    ],
  ]) {
    assert.throws(
      () => assertTask010ConnectionRevisionPins(revisions),
      hasSafetyCode("SOURCE_CONNECTION_PINS_INVALID"),
    );
  }
});

test("Task010 capacity artifact binds initial and ongoing launch limits", async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL(
        "../../docs/provider-source-capacity-measurement-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.doesNotThrow(() => parseTask010CapacityArtifact(artifact));
  for (const patch of [
    { pageRecordLimit: 499 },
    { incrementalRecordsPerPollAttempt: 4_999 },
  ]) {
    assert.throws(
      () => parseTask010CapacityArtifact({
        ...artifact,
        forecastInput: { ...artifact.forecastInput, ...patch },
      }),
      hasSafetyCode("CAPACITY_ARTIFACT_INVALID"),
    );
  }
});

test("Task010 configuration topology permits no source revisions yet", () => {
  assert.doesNotThrow(() => assertTask010ProviderSourceRevisionPins([]));
});

test("Task010 topology accepts only the sole v1 adapter, mapper, and observation tuple", () => {
  assert.doesNotThrow(() =>
    assertTask010ProviderSourceRevisionPins(currentSourcePins),
  );
});

test("Task010 topology rejects legacy and mixed provider source tuples", () => {
  const current = currentSourcePins[0];
  assert.ok(current);
  for (const patch of [
    {
      sourceAdapterVersion: "dataforrest-events-adapter-v2",
      mapperVersion: "2",
      normalizedContractVersion: "packscout.provider-observation.v2",
    },
    { sourceAdapterVersion: "dataforrest-events-adapter-v2" },
    { sourceAdapterVersion: "dataforrest-events-adapter-v3" },
    { mapperVersion: "2" },
    { normalizedContractVersion: "packscout.provider-observation.v2" },
  ]) {
    assert.throws(
      () =>
        assertTask010ProviderSourceRevisionPins([
          { ...current, ...patch },
        ]),
      hasSafetyCode("PROVIDER_SOURCE_PINS_INVALID"),
    );
  }
});
