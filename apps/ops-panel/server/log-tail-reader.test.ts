import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLogSourceRegistry, toLogSource } from "./core/log-sources.ts";
import { createLogStreamHub } from "./core/log-stream-hub.ts";
import type { LogLineRecord, LogMarkerRecord } from "./core/log-records.ts";
import { createLogTailReader } from "./log-tail-reader.ts";

/**
 * The filesystem half, exercised against real files: the pure engine already
 * proves the semantics, so this proves the adapter wires them to real bytes and
 * that the initial window and the live stream agree on identity.
 */

async function workspace(t: { after: (fn: () => void | Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "packscout-tail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const registry = createLogSourceRegistry();
  const hub = createLogStreamHub();
  const reads: string[] = [];
  const reader = createLogTailReader({
    directory,
    registry,
    hub,
    intervalMs: 10_000,
    readRange: async (filePath, range) => {
      reads.push(`${path.basename(filePath)}@${range.offset}+${range.length}`);
      const { open } = await import("node:fs/promises");
      const handle = await open(filePath, "r");
      try {
        const buffer = new Uint8Array(range.length);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          range.length,
          range.offset,
        );
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  });

  const lines: LogLineRecord[] = [];
  const markers: LogMarkerRecord[] = [];

  async function discover(service: string) {
    const fileName = `${service}.log`;
    const details = await stat(path.join(directory, fileName));
    const source = toLogSource(fileName, {
      deviceId: details.dev,
      inode: details.ino,
      sizeBytes: details.size,
      modifiedAtMs: details.mtimeMs,
    });
    assert.ok(source);
    registry.refresh([source]);
  }

  return {
    directory,
    registry,
    hub,
    reader,
    reads,
    lines,
    markers,
    discover,
    watch() {
      return hub.subscribe((batch) => {
        lines.push(...batch.lines);
        markers.push(...batch.markers);
      });
    },
    file: (service: string) => path.join(directory, `${service}.log`),
  };
}

test("an unattached panel stats files but never reads their bytes", async (t) => {
  const space = await workspace(t);
  await writeFile(space.file("worker"), "quiet\n");
  await space.discover("worker");

  await space.reader.tick();
  await appendFile(space.file("worker"), "more\n");
  await space.reader.tick();

  assert.deepEqual(space.reads, [], "no content read without a viewer");
  assert.deepEqual(space.lines, []);
  assert.equal(space.hub.tailer("worker").sizeBytes(), 11);
});

test("the initial window ends exactly where the live stream begins", async (t) => {
  const space = await workspace(t);
  await writeFile(space.file("worker"), "one\ntwo\nthree\n");
  await space.discover("worker");

  const release = space.watch();
  t.after(release);
  await space.reader.tick();

  const [window] = await space.reader.readWindows(500);
  assert.ok(window);
  assert.deepEqual(
    window.lines.map((line) => line.text),
    ["one", "two", "three"],
  );
  assert.equal(window.complete, true);
  assert.ok(
    window.lines.every((line) => line.backfilled),
    "window lines admit that their timestamp is a read time",
  );
  assert.equal(window.endOffset, space.hub.tailer("worker").cursor());

  await appendFile(space.file("worker"), "four\n");
  await space.reader.tick();

  const merged = [...window.lines, ...space.lines];
  const identities = merged.map((line) => line.id);
  assert.deepEqual(
    identities,
    [...new Set(identities)],
    "no identity appears twice across the window and the live stream",
  );
  assert.deepEqual(
    merged.map((line) => line.text),
    ["one", "two", "three", "four"],
    "and nothing between them went missing",
  );
});

test("rotation on disk surfaces a restart marker and fresh identities", async (t) => {
  const space = await workspace(t);
  await writeFile(space.file("worker"), "before\n");
  await space.discover("worker");
  const release = space.watch();
  t.after(release);
  await space.reader.tick();

  await appendFile(space.file("worker"), "still going\n");
  await space.reader.tick();
  const firstGeneration = space.lines.map((line) => line.id);
  assert.deepEqual(firstGeneration, ["line:worker:1:7"]);

  await rm(space.file("worker"));
  await writeFile(space.file("worker"), "after rotation\n");
  await space.discover("worker");
  await space.reader.tick();

  const restart = space.markers.find((marker) => marker.kind === "restarted");
  assert.ok(restart, "the operator is told the file changed underneath");
  assert.equal(restart?.service, "worker");
  const latest = space.lines.at(-1);
  assert.equal(latest?.text, "after rotation");
  assert.equal(latest?.generation, 2);
  assert.equal(latest?.offset, 0);
  assert.ok(
    !firstGeneration.includes(latest?.id ?? ""),
    "a new generation cannot collide with the identities of the old one",
  );
});

test("a vanished file is reported and picked back up when it returns", async (t) => {
  const space = await workspace(t);
  await writeFile(space.file("admin"), "running\n");
  await space.discover("admin");
  const release = space.watch();
  t.after(release);
  await space.reader.tick();

  await rm(space.file("admin"));
  registryClear(space.registry);
  await space.reader.tick();
  assert.equal(space.markers.at(-1)?.kind, "disappeared");

  await writeFile(space.file("admin"), "back\n");
  await space.discover("admin");
  await space.reader.tick();
  assert.equal(space.markers.at(-1)?.kind, "appeared");
  assert.equal(space.lines.at(-1)?.text, "back");
});

test("every service rides one subscription, and detaching releases the tails", async (t) => {
  const space = await workspace(t);
  await writeFile(space.file("worker"), "w\n");
  await writeFile(space.file("admin"), "a\n");
  const details = await Promise.all(
    ["worker", "admin"].map(async (service) => {
      const info = await stat(space.file(service));
      return toLogSource(`${service}.log`, {
        deviceId: info.dev,
        inode: info.ino,
        sizeBytes: info.size,
        modifiedAtMs: info.mtimeMs,
      })!;
    }),
  );
  space.registry.refresh(details);

  const release = space.watch();
  await space.reader.tick();
  assert.equal(space.hub.tailer("worker").viewerCount(), 1);
  assert.equal(space.hub.tailer("admin").viewerCount(), 1);

  await appendFile(space.file("worker"), "from worker\n");
  await appendFile(space.file("admin"), "from admin\n");
  await space.reader.tick();
  assert.deepEqual(
    space.lines.map((line) => line.service).sort(),
    ["admin", "worker"],
    "one connection carries every service",
  );

  release();
  assert.equal(space.hub.tailer("worker").viewerCount(), 0);
  assert.equal(space.hub.tailer("admin").viewerCount(), 0);
  assert.equal(space.hub.tailer("worker").cursor(), null);
});

function registryClear(registry: ReturnType<typeof createLogSourceRegistry>): void {
  registry.refresh([]);
}
