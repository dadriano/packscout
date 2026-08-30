import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { providerSourceMemoryProfile } = await tsImport("./provider-source-page-memory-profile.mts", import.meta.url);
test("memory benchmark covers configurable maximum at four-lane8MiB and preserves fixed Courtyard capacity variants", () => {
  const baseline = providerSourceMemoryProfile([]);
  assert.deepEqual({ ...baseline, manifest: baseline.manifest.adapterVersion }, {
    name: "maximum-request", manifest: "dataforrest-events-adapter-v3", concurrentPages: 4, warmupPageCount: 12,
    trialCount: 5, pagesPerTrial: 20, recordsPerPage: 5000, emptyObjectFactsPerRecord: 82, nativeNodeTarget: null });
  assert.equal(baseline.manifest.requestBounds.pageLimit, 5000);
  assert.equal(baseline.manifest.requestBounds.maximumResponseBytes, 8388608);
  for (const name of ["courtyard-v2-wide", "courtyard-v2-distributed"]) {
    const profile = providerSourceMemoryProfile(["--profile", name]);
    assert.equal(profile.manifest.adapterVersion, "dataforrest-courtyard-distributed-adapter-v2");
    assert.equal(profile.manifest.requestBounds.maximumResponseBytes, 33554432);
    assert.equal(profile.nativeNodeTarget, 640000); assert.equal(profile.concurrentPages, 1);
    assert.equal(profile.recordsPerPage, name.endsWith("wide") ? 1 : 100);
    assert.equal(profile.warmupPageCount, 4); assert.equal(profile.trialCount * profile.pagesPerTrial, 12);
  }
  for (const args of [["--profile"], ["--profile", "unknown"], ["--bytes", "33554433"],
    ["--profile", "courtyard-v2-wide", "--nodes", "1000000"], ["--token", "private-fixture"]]) {
    assert.throws(() => providerSourceMemoryProfile(args), (error) => error.message === "PROVIDER_SOURCE_MEMORY_PROFILE_INVALID");
  }
});
