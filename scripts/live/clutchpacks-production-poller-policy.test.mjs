import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { commit, fixture, publisherModule, policyHashKey, policyPathKey } from "./clutchpacks-production-poller-fixture.mjs";
const { clutchpacksProductionPollerPolicySchema, readClutchpacksProductionPollerSettings: read,
  revalidateClutchpacksProductionPollerSettings: revalidate,
  clutchpacksProductionForbiddenEnvironment } = await tsImport("./clutchpacks-production-poller-policy.mts", import.meta.url);

test("production poller admission binds private exact policy bytes and both clean tracked checkouts", async t => {
  const f = await fixture(t), settings = await read(f.environment, f.resident);
  assert.equal(settings.fingerprint, f.environment[policyHashKey]); assert.deepEqual(settings.policy, f.policy);
  for (const value of [settings, settings.policy, settings.policy.pins, settings.policy.cadence,
    settings.policy.resident, settings.policy.publisher, settings.policy.baseSourceConfig]) assert.ok(Object.isFrozen(value));
  await revalidate(settings, f.resident);
  await assert.rejects(read(f.environment, f.publisher), /POLICY_INVALID/);
  await assert.rejects(read({}, f.resident), /POLICY_INVALID/);
  await assert.rejects(read({ ...f.environment, [policyHashKey]: "f".repeat(64) }, f.resident), /POLICY_INVALID/);
  await assert.rejects(read({ ...f.environment, [policyPathKey]: "relative.json" }, f.resident), /POLICY_INVALID/);
  await assert.rejects(readFile(f.policy.artifactDirectory), { code: "ENOENT" });
});
test("strict production policy refuses foreign provider, unknown data, unsafe paths and unsupported cadence", async t => {
  const f = await fixture(t);
  for (const mutate of [p => { p.unknown = true; }, p => { p.pins.providerKey = "courtyard"; },
    p => { p.pins.unknown = true; }, p => { p.resident.commit = "A".repeat(40); }, p => { p.publisher.moduleSha256 = "a"; },
    p => { p.resident.checkout = "/tmp/../tmp/resident"; }, p => { p.baseSourceConfig.path = "relative"; },
    p => { p.artifactDirectory = "/tmp/line\nbreak"; }, p => { p.cadence.kind = "central"; },
    ...[59, 61, "60"].map(interval => p => { p.cadence.intervalSeconds = interval; }),
    ...[0, 900001, 0.5, "1000"].map(timeout => p => { p.timeoutMilliseconds = timeout; })]) {
    const policy = structuredClone(f.policy); mutate(policy); assert.equal(clutchpacksProductionPollerPolicySchema.safeParse(policy).success, false);
  }
});
test("private policy and source configuration reject permissive files and symlink aliases", async t => {
  const f = await fixture(t);
  await chmod(f.policyPath, 0o644); await assert.rejects(read(f.environment, f.resident), /POLICY_INVALID/); await chmod(f.policyPath, 0o600);
  const original = path.join(f.root, "original-policy.json"); await rename(f.policyPath, original); await symlink(original, f.policyPath);
  await assert.rejects(read(f.environment, f.resident), /POLICY_INVALID/);
  f.environment[policyPathKey] = original;
  await chmod(f.policy.baseSourceConfig.path, 0o400); await assert.rejects(read(f.environment, f.resident), /DEPLOYMENT_CHANGED/);
  await chmod(f.policy.baseSourceConfig.path, 0o600);
  const config = path.join(f.root, "original-config.json"); await rename(f.policy.baseSourceConfig.path, config);
  await symlink(config, f.policy.baseSourceConfig.path); await assert.rejects(read(f.environment, f.resident), /DEPLOYMENT_CHANGED/);
});
test("policy, config, publisher hash and either clean commit drift refuse the next invocation", async t => {
  const f = await fixture(t), settings = await read(f.environment, f.resident);
  const bytes = await readFile(f.policyPath); await writeFile(f.policyPath, `${bytes.toString()} `);
  await assert.rejects(revalidate(settings, f.resident), /POLICY_INVALID/); await writeFile(f.policyPath, bytes);
  const config = await readFile(f.policy.baseSourceConfig.path); await writeFile(f.policy.baseSourceConfig.path, "changed");
  await assert.rejects(revalidate(settings, f.resident), /DEPLOYMENT_CHANGED/); await writeFile(f.policy.baseSourceConfig.path, config);
  const module = path.join(f.publisher, publisherModule), source = await readFile(module);
  await writeFile(module, "changed publisher"); await assert.rejects(revalidate(settings, f.resident), /DEPLOYMENT_CHANGED/);
  await writeFile(module, source);
  f.policy.publisher.moduleSha256 = "f".repeat(64); await f.writePolicy();
  await assert.rejects(read(f.environment, f.resident), /DEPLOYMENT_CHANGED/);
  f.policy.publisher.moduleSha256 = settings.policy.publisher.moduleSha256; await f.writePolicy();
  await writeFile(path.join(f.resident, "unreviewed.mjs"), "unreviewed");
  await assert.rejects(read(f.environment, f.resident), /DEPLOYMENT_CHANGED/);
  await commit(f.resident); await assert.rejects(read(f.environment, f.resident), /DEPLOYMENT_CHANGED/);
});
test("artifact paths cannot dirty either reviewed checkout", async t => {
  const f = await fixture(t);
  for (const checkout of [f.resident, f.publisher]) {
    f.policy.artifactDirectory = path.join(checkout, "artifacts"); await f.writePolicy();
    await assert.rejects(read(f.environment, f.resident), /POLICY_INVALID/);
  }
  const alias = path.join(f.root, "alias"); await mkdir(path.join(f.root, "outside"));
  f.policy.artifactDirectory = path.join(f.root, "artifacts");
  await symlink(f.resident, alias); f.policy.resident.checkout = alias; await f.writePolicy();
  await assert.rejects(read(f.environment, alias), /DEPLOYMENT_CHANGED/);
});
test("the ignored resident environment is private, immutable and cannot be overridden by ambient routing or secrets", async t => {
  const f = await fixture(t), settings = await read(f.environment, f.resident), file = path.join(f.resident, ".env");
  for (const key of clutchpacksProductionForbiddenEnvironment) {
    await assert.rejects(read({ ...f.environment, [key]: "" }, f.resident), /ENVIRONMENT_INVALID/);
  }
  const original = await readFile(file); await writeFile(file, "PACKSCOUT_DATABASE_MODE=changed\n");
  await assert.rejects(revalidate(settings, f.resident), /DEPLOYMENT_CHANGED/); await writeFile(file, original);
  await chmod(file, 0o644); await assert.rejects(revalidate(settings, f.resident), /DEPLOYMENT_CHANGED/); await chmod(file, 0o600);
  const hidden = path.join(f.root, "environment-original"); await rename(file, hidden); await symlink(hidden, file);
  await assert.rejects(revalidate(settings, f.resident), /DEPLOYMENT_CHANGED/);
});
