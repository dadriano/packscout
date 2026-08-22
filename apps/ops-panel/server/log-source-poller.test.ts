import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createLogSourceRegistry } from "./core/log-sources.ts";
import { createLogSourcePoller } from "./log-source-poller.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ops-panel-logs-"));
  directories.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function poller(directory: string) {
  const registry = createLogSourceRegistry();
  return {
    registry,
    instance: createLogSourcePoller({ directory, registry, intervalMs: 1_000 }),
  };
}

test("a missing log directory yields no sources instead of failing", async () => {
  const directory = path.join(await temporaryDirectory(), "not-created-yet");
  const { instance, registry } = poller(directory);
  assert.equal(await instance.refresh(), null);
  assert.deepEqual(registry.snapshot(), []);
});

test("only files matching the convention become sources", async () => {
  const directory = await temporaryDirectory();
  await writeFile(path.join(directory, "frontend.log"), "one\n");
  await writeFile(path.join(directory, "ops-panel.log"), "two\n");
  await writeFile(path.join(directory, "Frontend.log"), "ignored\n");
  await writeFile(path.join(directory, "notes.txt"), "ignored\n");
  await writeFile(path.join(directory, "frontend.log.1"), "ignored\n");

  const { instance, registry } = poller(directory);
  await instance.refresh();
  assert.deepEqual(
    registry.snapshot().map((source) => source.service),
    ["frontend", "ops-panel"],
  );
});

test("files that appear, change, and disappear are picked up mid-session", async () => {
  const directory = await temporaryDirectory();
  await writeFile(path.join(directory, "admin.log"), "start\n");

  const { instance, registry } = poller(directory);
  const changes: string[] = [];
  registry.subscribe((change) => {
    changes.push(
      [
        `+${change.added.map((entry) => entry.service).join(",")}`,
        `-${change.removed.map((entry) => entry.service).join(",")}`,
        `~${change.changed.map((entry) => entry.service).join(",")}`,
      ].join(" "),
    );
  });

  await instance.refresh();
  assert.deepEqual(
    registry.snapshot().map((source) => source.service),
    ["admin"],
  );

  await writeFile(path.join(directory, "worker.log"), "hello\n");
  await instance.refresh();
  assert.deepEqual(
    registry.snapshot().map((source) => source.service),
    ["admin", "worker"],
  );

  await writeFile(path.join(directory, "worker.log"), "hello again\n", { flag: "a" });
  await instance.refresh();
  assert.equal(
    registry.snapshot().find((source) => source.service === "worker")?.sizeBytes,
    18,
  );

  await rm(path.join(directory, "admin.log"));
  await instance.refresh();
  assert.deepEqual(
    registry.snapshot().map((source) => source.service),
    ["worker"],
  );

  assert.equal(changes.length, 4);
  assert.equal(changes[1], "+worker - ~");
  assert.equal(changes[2], "+ - ~worker");
  assert.equal(changes[3], "+ -admin ~");
});

test("a renamed log file moves the service without a restart", async () => {
  const directory = await temporaryDirectory();
  await writeFile(path.join(directory, "worker.log"), "run\n");
  const { instance, registry } = poller(directory);
  await instance.refresh();

  await rename(
    path.join(directory, "worker.log"),
    path.join(directory, "worker-two.log"),
  );
  const change = await instance.refresh();
  assert.ok(change);
  assert.deepEqual(
    change.added.map((entry) => entry.service),
    ["worker-two"],
  );
  assert.deepEqual(
    change.removed.map((entry) => entry.service),
    ["worker"],
  );
  assert.deepEqual(
    registry.snapshot().map((source) => source.service),
    ["worker-two"],
  );
});

test("a rotated file keeps its service but reports a new identity", async () => {
  const directory = await temporaryDirectory();
  const logPath = path.join(directory, "worker.log");
  await writeFile(logPath, "first\n");
  const { instance, registry } = poller(directory);
  await instance.refresh();
  const before = registry.snapshot()[0]?.fileId;

  await rename(logPath, path.join(directory, "worker-archived.log"));
  await writeFile(logPath, "second\n");
  await instance.refresh();
  const after = registry.snapshot().find((source) => source.service === "worker");

  assert.ok(before);
  assert.ok(after);
  assert.notEqual(after.fileId, before);
});

test("directories inside the log directory are ignored", async () => {
  const directory = await temporaryDirectory();
  const { instance, registry } = poller(directory);
  await mkdtemp(path.join(directory, "nested-"));
  await instance.refresh();
  assert.deepEqual(registry.snapshot(), []);
});

test("start and stop own the polling timer", async () => {
  const directory = await temporaryDirectory();
  const { instance } = poller(directory);
  assert.equal(instance.isRunning(), false);
  instance.start();
  assert.equal(instance.isRunning(), true);
  instance.start();
  instance.stop();
  assert.equal(instance.isRunning(), false);
});
