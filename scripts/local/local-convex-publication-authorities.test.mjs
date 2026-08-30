import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  installOwnedLocalConvexPublicationAuthorities,
  runLocalConvexPublicationCommand,
  withVerifiedLocalConvexPublicationAuthorityCleanup,
} = await tsImport("./local-convex-publication-authorities.mts", import.meta.url);

const KEYS = [
  "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
  "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
  "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
  "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS",
];
const PERSISTENT_KEYS = new Set([
  "PACKSCOUT_RUNTIME_ENVIRONMENT",
  "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
]);
const FIXTURE_SECRET = "fixture-only-signing-secret-not-a-real-credential";
const VALUES = new Map(KEYS.map((name, index) => [name, `${FIXTURE_SECRET}:${index}`]));

function deferred() {
  let resolve;
  const promise = new Promise((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function fakeCommands(options = {}) {
  const environment = { UNRELATED_CREDENTIAL: "leave-this-value-alone", ...options.initial };
  const removals = [];
  const writes = [];
  let reads = 0;
  return {
    environment,
    removals,
    writes,
    get reads() { return reads; },
    commands: {
      async readEnvironment() {
        reads += 1;
        await options.beforeRead?.({ reads, environment });
        return { ...environment };
      },
      async setEnvironmentValue(name, value) {
        writes.push(name);
        if (options.failSetBefore === name) throw new Error(FIXTURE_SECRET);
        environment[name] = value;
        if (options.failSetAfter === name) throw new Error(FIXTURE_SECRET);
      },
      async removeEnvironmentValue(name) {
        removals.push(name);
        if (options.failRemove === name) throw new Error(FIXTURE_SECRET);
        if (options.acknowledgeWithoutRemoval !== name) delete environment[name];
        if (options.failRemoveAfter === name) throw new Error(FIXTURE_SECRET);
      },
    },
  };
}

function install(fake) {
  return installOwnedLocalConvexPublicationAuthorities({
    commands: fake.commands,
    authorityEnvironmentKeys: [...KEYS, "PACKSCOUT_HEAT_PUBLICATION_KEY_IDS"],
    persistentEnvironmentKeys: PERSISTENT_KEYS,
    async configure({ set }) {
      await set("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
      await set("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", "approved-origin-hash");
      for (const [name, value] of VALUES) await set(name, value);
    },
  });
}

function assertPersistentState(fake) {
  assert.equal(fake.environment.PACKSCOUT_RUNTIME_ENVIRONMENT, "local");
  assert.equal(fake.environment.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH, "approved-origin-hash");
  assert.equal(fake.environment.UNRELATED_CREDENTIAL, "leave-this-value-alone");
  assert.ok(fake.removals.every((name) => KEYS.includes(name)));
}

function isSanitizedCleanupFailure(error) {
  assert.equal(error.code, "LOCAL_CONVEX_PUBLICATION_AUTHORITY_CLEANUP_FAILED");
  assert.equal(String(error).includes(FIXTURE_SECRET), false);
  return true;
}

test("returns ready only after all owned authorities are removed and absence is verified", async () => {
  const finalReadEntered = deferred();
  const releaseFinalRead = deferred();
  const fake = fakeCommands({
    async beforeRead({ reads }) {
      if (reads === KEYS.length + 2) {
        finalReadEntered.resolve();
        await releaseFinalRead.promise;
      }
    },
  });
  let readyObserved = false;
  const execution = withVerifiedLocalConvexPublicationAuthorityCleanup({
    install: () => install(fake),
    async publish() {
      assert.ok(KEYS.every((name) => fake.environment[name] === VALUES.get(name)));
      return { status: "ready" };
    },
  }).then((result) => { readyObserved = true; return result; });
  await finalReadEntered.promise;
  assert.equal(readyObserved, false);
  assert.deepEqual(fake.removals, [...KEYS].reverse());
  releaseFinalRead.resolve();
  assert.deepEqual(await execution, { status: "ready" });
  assert.ok(KEYS.every((name) => !Object.hasOwn(fake.environment, name)));
  assertPersistentState(fake);
});

test("a first removal failure still attempts every owned key and refuses ready", async () => {
  const fake = fakeCommands({ failRemove: KEYS.at(-1) });
  let readyObserved = false;
  await assert.rejects(
    withVerifiedLocalConvexPublicationAuthorityCleanup({
      install: () => install(fake),
      async publish() { return { status: "ready" }; },
    }).then(() => { readyObserved = true; }),
    isSanitizedCleanupFailure,
  );
  assert.equal(readyObserved, false);
  assert.deepEqual(fake.removals, [...KEYS].reverse());
  assert.equal(fake.environment[KEYS.at(-1)], VALUES.get(KEYS.at(-1)));
  assert.ok(KEYS.slice(0, -1).every((name) => !Object.hasOwn(fake.environment, name)));
  assertPersistentState(fake);
});

test("successful removal acknowledgements without actual deletion fail readback", async () => {
  const fake = fakeCommands({ acknowledgeWithoutRemoval: KEYS[1] });
  const cleanup = await install(fake);
  await assert.rejects(cleanup(), isSanitizedCleanupFailure);
  assert.deepEqual(fake.removals, [...KEYS].reverse());
  assertPersistentState(fake);
});

test("an unavailable final authority readback refuses successful publication", async () => {
  const fake = fakeCommands({
    async beforeRead({ reads }) {
      if (reads === KEYS.length + 2) throw new Error(FIXTURE_SECRET);
    },
  });
  await assert.rejects(
    withVerifiedLocalConvexPublicationAuthorityCleanup({
      install: () => install(fake),
      async publish() { return { status: "ready" }; },
    }),
    isSanitizedCleanupFailure,
  );
  assert.deepEqual(fake.removals, [...KEYS].reverse());
  assertPersistentState(fake);
});

test("partial install cleans an acknowledged write and an unacknowledged committed write", async () => {
  const fake = fakeCommands({ failSetAfter: KEYS[1] });
  let published = false;
  await assert.rejects(
    withVerifiedLocalConvexPublicationAuthorityCleanup({
      install: () => install(fake),
      async publish() { published = true; },
    }),
  );
  assert.equal(published, false);
  assert.deepEqual(fake.removals, [KEYS[1], KEYS[0]]);
  assert.ok(KEYS.every((name) => !Object.hasOwn(fake.environment, name)));
  assertPersistentState(fake);
});

test("partial install cleanup failure remains sanitized and attempts earlier owned keys", async () => {
  const fake = fakeCommands({ failSetAfter: KEYS[1], failRemove: KEYS[1] });
  await assert.rejects(install(fake), isSanitizedCleanupFailure);
  assert.deepEqual(fake.removals, [KEYS[1], KEYS[0]]);
  assertPersistentState(fake);
});

test("a failed write that did not commit does not require a destructive cleanup", async () => {
  const fake = fakeCommands({ failSetBefore: KEYS[1] });
  await assert.rejects(install(fake));
  assert.deepEqual(fake.removals, [KEYS[0]]);
  assert.ok(KEYS.every((name) => !Object.hasOwn(fake.environment, name)));
  assertPersistentState(fake);
});

test("preexisting credentials are refused before any write or removal", async () => {
  const fake = fakeCommands({ initial: { [KEYS[2]]: "preexisting-authority" } });
  await assert.rejects(
    install(fake),
    (error) => error.code === "LOCAL_CONVEX_PUBLICATION_AUTHORITY_NOT_PRISTINE",
  );
  assert.equal(fake.environment[KEYS[2]], "preexisting-authority");
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(fake.removals, []);
});

test("cleanup preserves a subsequently replaced credential and reports unverifiable ownership", async () => {
  const fake = fakeCommands();
  const cleanup = await install(fake);
  fake.environment[KEYS[1]] = "new-owner-authority";
  await assert.rejects(cleanup(), isSanitizedCleanupFailure);
  assert.equal(fake.environment[KEYS[1]], "new-owner-authority");
  assert.deepEqual(fake.removals, [...KEYS].reverse().filter((name) => name !== KEYS[1]));
  assertPersistentState(fake);
});

test("publication errors still remove and verify every owned authority", async () => {
  const fake = fakeCommands();
  const publicationFailure = new Error("SANITIZED_PUBLICATION_REFUSAL");
  await assert.rejects(
    withVerifiedLocalConvexPublicationAuthorityCleanup({
      install: () => install(fake),
      async publish() { throw publicationFailure; },
    }),
    (error) => error === publicationFailure,
  );
  assert.ok(KEYS.every((name) => !Object.hasOwn(fake.environment, name)));
  assertPersistentState(fake);
});

test("readback can prove cleanup after a lost removal acknowledgement", async () => {
  const fake = fakeCommands({ failRemoveAfter: KEYS[2] });
  const cleanup = await install(fake);
  await cleanup();
  await cleanup();
  assert.ok(KEYS.every((name) => !Object.hasOwn(fake.environment, name)));
  assertPersistentState(fake);
});

function fakeSpawn(options = {}) {
  const calls = [];
  const inputChunks = [];
  return {
    calls,
    inputChunks,
    spawnProcess(command, args, spawnOptions) {
      calls.push({ command, args, options: spawnOptions });
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin.on("data", (chunk) => inputChunks.push(Buffer.from(chunk)));
      const complete = () => queueMicrotask(() => {
        if (options.stdoutBeforeExit) child.stdout.write(options.stdoutBeforeExit);
        child.stderr.write(FIXTURE_SECRET);
        if (options.error) child.emit("error", new Error(FIXTURE_SECRET));
        child.emit("exit", options.exitCode ?? 0, null);
        queueMicrotask(() => {
          if (options.stdoutAfterExit) child.stdout.write(options.stdoutAfterExit);
          child.stdout.end();
          child.stderr.end();
          child.emit("close", options.exitCode ?? 0, null);
        });
      });
      child.stdin.on("finish", complete);
      if (spawnOptions.stdio[0] === "ignore") complete();
      return child;
    },
  };
}

test("signing secret bytes use stdin exactly and never enter argv", async () => {
  const fake = fakeSpawn();
  const value = JSON.stringify({ "fixture-key": FIXTURE_SECRET });
  await runLocalConvexPublicationCommand({
    args: ["env", "set", KEYS[0]],
    standardInput: value,
    environment: {},
    cwd: "/fixture/local-checkout",
    spawnProcess: fake.spawnProcess,
  });
  assert.deepEqual(fake.calls[0].args, ["--no-install", "convex", "env", "set", KEYS[0]]);
  assert.equal(JSON.stringify(fake.calls).includes(FIXTURE_SECRET), false);
  assert.deepEqual(Buffer.concat(fake.inputChunks), Buffer.from(value, "utf8"));
  assert.equal(fake.calls[0].options.stdio[0], "pipe");
  assert.equal(fake.calls[0].options.shell, false);
});

test("captured authority readback includes stdout drained after process exit", async () => {
  const fake = fakeSpawn({
    stdoutBeforeExit: "PACKSCOUT_RUNTIME_ENVIRONMENT=local\n",
    stdoutAfterExit: "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES=still-present\n",
  });
  const output = await runLocalConvexPublicationCommand({
    args: ["env", "list"],
    capture: true,
    environment: {},
    cwd: "/fixture/local-checkout",
    spawnProcess: fake.spawnProcess,
  });
  assert.equal(
    output,
    "PACKSCOUT_RUNTIME_ENVIRONMENT=local\nPACKSCOUT_CATALOG_MANIFEST_KEY_ROLES=still-present\n",
  );
});

for (const options of [{ exitCode: 1 }, { error: true }]) {
  test(`command ${options.error ? "startup" : "exit"} failures never expose stderr or stdin secrets`, async () => {
    const fake = fakeSpawn(options);
    await assert.rejects(
      runLocalConvexPublicationCommand({
        args: ["env", "set", KEYS[0]],
        standardInput: FIXTURE_SECRET,
        capture: true,
        environment: {},
        cwd: "/fixture/local-checkout",
        spawnProcess: fake.spawnProcess,
      }),
      (error) => {
        assert.equal(error.message, "Local Convex command failed.");
        assert.equal(String(error).includes(FIXTURE_SECRET), false);
        return true;
      },
    );
    assert.equal(JSON.stringify(fake.calls).includes(FIXTURE_SECRET), false);
  });
}
