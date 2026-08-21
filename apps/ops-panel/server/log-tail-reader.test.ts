import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLogSourceRegistry, toLogSource } from "./core/log-sources.ts";
import { createLogStreamHub } from "./core/log-stream-hub.ts";
import type { LogLineRecord, LogMarkerRecord } from "./core/log-records.ts";
import { openLogFile } from "./log-file-handle.ts";
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
  // Runs once, immediately after a file is opened and before anything is read
  // from it: the moment a rotation would have to happen to be dangerous.
  let afterOpen: (() => Promise<void>) | null = null;
  const reader = createLogTailReader({
    directory,
    registry,
    hub,
    intervalMs: 10_000,
    openFile: async (filePath) => {
      const file = await openLogFile(filePath);
      const hook = afterOpen;
      afterOpen = null;
      if (hook) await hook();
      if (file === null) return null;
      return {
        ...file,
        read: async (range) => {
          reads.push(`${path.basename(filePath)}@${range.offset}+${range.length}`);
          return file.read(range);
        },
      };
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
    /** Do this once, after the next open and before that file is read. */
    onceAfterOpen(hook: () => Promise<void>) {
      afterOpen = hook;
    },
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

/**
 * The handoff, in the order a browser actually produces it: the panel has been
 * polling while nobody watched, a viewer attaches, and the initial window is
 * read *before* the next tick. The window must leave the tail a cursor at its
 * own boundary — otherwise the tick aligns against a newer end-of-file and the
 * bytes written in between belong to neither the window nor the stream.
 */
test("a line written between the initial window and the first tick is not skipped", async (t) => {
  const space = await workspace(t);
  await writeFile(space.file("worker"), "one\n");
  await space.discover("worker");
  // Polled while passive: observed, but with no cursor to continue from.
  await space.reader.tick();

  const release = space.watch();
  t.after(release);

  const [window] = await space.reader.readWindows(500);
  assert.ok(window);
  assert.deepEqual(
    window.lines.map((line) => line.text),
    ["one"],
  );
  assert.equal(
    space.hub.tailer("worker").cursor(),
    window.endOffset,
    "the tail continues from exactly where the window stopped",
  );

  await appendFile(space.file("worker"), "two\n");
  await space.reader.tick();

  assert.deepEqual(
    space.lines.map((line) => line.text),
    ["two"],
    "the append between the window and the tick was streamed, not skipped",
  );
  const merged = [...window.lines, ...space.lines];
  assert.deepEqual(
    merged.map((line) => line.text),
    ["one", "two"],
    "and the window and the stream still join without a duplicate",
  );
});

/**
 * A plan derived from one file and bytes read from another is how rotation
 * turns into duplicated, misordered output that looks real. The descriptor is
 * the anchor: whatever the name points at afterwards, this pass finishes
 * reading the file it observed.
 */
test("bytes come from the file that was observed, not from whatever replaced it", async (t) => {
  const space = await workspace(t);
  await writeFile(space.file("worker"), "before\n");
  await space.discover("worker");
  const release = space.watch();
  t.after(release);
  await space.reader.tick();

  await appendFile(space.file("worker"), "still going\n");
  space.onceAfterOpen(async () => {
    // The file is replaced behind its name after this pass opened it.
    await rm(space.file("worker"));
    await writeFile(space.file("worker"), "from the replacement file\n");
  });
  await space.reader.tick();

  assert.deepEqual(
    space.lines.map((line) => line.text),
    ["still going"],
    "the replacement file's bytes were not published under the old offsets",
  );
  assert.equal(space.lines.at(-1)?.generation, 1);

  // The next pass sees the replacement honestly: a new generation, from zero.
  await space.discover("worker");
  await space.reader.tick();
  assert.equal(
    space.markers.some((marker) => marker.kind === "restarted"),
    true,
  );
  assert.equal(space.lines.at(-1)?.text, "from the replacement file");
  assert.equal(space.lines.at(-1)?.generation, 2);
  assert.equal(space.lines.at(-1)?.offset, 0);
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
