import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogSourceRegistry,
  diffLogSources,
  toLogSource,
  type LogSource,
} from "./log-sources.ts";

function identity(inode: number, sizeBytes: number, modifiedAtMs: number) {
  return { deviceId: 1, inode, sizeBytes, modifiedAtMs };
}

function source(
  service: string,
  overrides: Partial<LogSource> = {},
): LogSource {
  return {
    service,
    fileName: `${service}.log`,
    fileId: `1:${service.length}`,
    sizeBytes: 100,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("directory entries become sources only when the name is safe", () => {
  assert.deepEqual(toLogSource("frontend.log", identity(11, 42, 0)), {
    service: "frontend",
    fileName: "frontend.log",
    fileId: "1:11",
    sizeBytes: 42,
    modifiedAt: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(toLogSource("Frontend.log", identity(11, 42, 0)), null);
  assert.equal(toLogSource("../escape.log", identity(11, 42, 0)), null);
  assert.equal(toLogSource("frontend.log", identity(11, -1, 0)), null);
  assert.equal(toLogSource("frontend.log", identity(11, 1, Number.NaN)), null);
});

test("a diff reports appearing, disappearing, and changing files", () => {
  const before = [source("admin"), source("frontend")];
  const after = [
    source("frontend", { sizeBytes: 900 }),
    source("worker"),
  ];
  const diff = diffLogSources(before, after);
  assert.deepEqual(
    diff.added.map((entry) => entry.service),
    ["worker"],
  );
  assert.deepEqual(
    diff.removed.map((entry) => entry.service),
    ["admin"],
  );
  assert.deepEqual(
    diff.changed.map((entry) => entry.service),
    ["frontend"],
  );
});

test("a rotated file is a change because its identity moved", () => {
  const diff = diffLogSources(
    [source("worker", { fileId: "1:10" })],
    [source("worker", { fileId: "1:11" })],
  );
  assert.deepEqual(
    diff.changed.map((entry) => entry.fileId),
    ["1:11"],
  );
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
});

test("the registry publishes mid-session appearance without a restart", () => {
  const registry = createLogSourceRegistry([source("frontend")]);
  const changes: string[][] = [];
  registry.subscribe((change) => {
    changes.push(change.sources.map((entry) => entry.service));
  });

  const change = registry.refresh([source("frontend"), source("worker")]);
  assert.ok(change);
  assert.deepEqual(
    change.added.map((entry) => entry.service),
    ["worker"],
  );
  assert.equal(change.revision, 1);
  assert.deepEqual(changes, [["frontend", "worker"]]);
  assert.deepEqual(
    registry.snapshot().map((entry) => entry.service),
    ["frontend", "worker"],
  );
});

test("the registry publishes mid-session disappearance", () => {
  const registry = createLogSourceRegistry([source("admin"), source("worker")]);
  const change = registry.refresh([source("admin")]);
  assert.ok(change);
  assert.deepEqual(
    change.removed.map((entry) => entry.service),
    ["worker"],
  );
  assert.deepEqual(
    registry.snapshot().map((entry) => entry.service),
    ["admin"],
  );
});

test("a rename mid-session removes the old service and adds the new one", () => {
  const registry = createLogSourceRegistry([
    source("worker", { fileId: "1:33" }),
  ]);
  const change = registry.refresh([
    source("worker-alpha", { fileId: "1:33", fileName: "worker-alpha.log" }),
  ]);
  assert.ok(change);
  assert.deepEqual(
    change.added.map((entry) => entry.service),
    ["worker-alpha"],
  );
  assert.deepEqual(
    change.removed.map((entry) => entry.service),
    ["worker"],
  );
});

test("an unchanged listing publishes nothing", () => {
  const registry = createLogSourceRegistry([source("frontend")]);
  let notified = 0;
  registry.subscribe(() => {
    notified += 1;
  });
  assert.equal(registry.refresh([source("frontend")]), null);
  assert.equal(notified, 0);
  assert.equal(registry.revision(), 0);
});

test("unsubscribing releases the listener so streams can tear down", () => {
  const registry = createLogSourceRegistry();
  const unsubscribe = registry.subscribe(() => {});
  assert.equal(registry.listenerCount(), 1);
  unsubscribe();
  assert.equal(registry.listenerCount(), 0);
  registry.refresh([source("frontend")]);
  assert.equal(registry.listenerCount(), 0);
});
