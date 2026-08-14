import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  providerArchiveMembersV2,
  providerArchiveChildEnvironmentV2,
  providerArchiveCursorV2,
  streamProviderArchiveV2,
} from "./provider-archive-reader.ts";

const execFileAsync = promisify(execFile);
function record(input: {
  stream: "catalog" | "pulls" | "trades";
  recordId: string;
}) {
  const common = {
    stream: input.stream,
    platform: "fixture",
    record_id: input.recordId,
    occurred_at: "2026-08-13T00:00:00Z",
    collected_at: "2026-08-13T00:01:00Z",
    data: {},
  };
  if (input.stream === "catalog") {
    return {
      ...common,
      entity: input.recordId.startsWith("pack") ? "pack" : "card",
      first_seen_at: "2026-08-12T00:00:00Z",
    };
  }
  if (input.stream === "pulls") {
    return { ...common, pack_id: "pack-1", card_id: "card-1" };
  }
  return {
    ...common,
    card_id: "card-1",
    event_type: "sale",
    amount: 10,
    currency: "USD",
    payment_method: null,
    tx_hash: `tx-${input.recordId}`,
  };
}

async function syntheticArchive(): Promise<{
  archivePath: string;
  cleanup(): Promise<void>;
  lines: readonly string[];
  sha256: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "packscout-archive-v2-"));
  const root = join(directory, "dataset");
  await mkdir(root);
  const records = [
    record({ stream: "catalog", recordId: "pack-1" }),
    record({ stream: "catalog", recordId: "card-1" }),
    record({ stream: "pulls", recordId: "pull-1" }),
    record({ stream: "trades", recordId: "trade-1" }),
  ];
  const lines = records.map((value) => `${JSON.stringify(value)}\n`);
  const kinds = ["packs", "cards", "pulls", "trades"] as const;
  for (const [index, kind] of kinds.entries()) {
    await writeFile(join(root, `fixture_${kind}.ndjson`), lines[index]!, "utf8");
  }
  const archivePath = join(directory, "fixture.zip");
  await execFileAsync("zip", ["-q", "-r", archivePath, "dataset"], {
    cwd: directory,
  });
  return {
    archivePath,
    lines,
    sha256: createHash("sha256").update(await readFile(archivePath)).digest("hex"),
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

test("archive reader streams bounded exact-byte chunks with stable resumable cursors", async (context) => {
  const archive = await syntheticArchive();
  context.after(archive.cleanup);
  const chunks = [];
  for await (const chunk of streamProviderArchiveV2({
    archivePath: archive.archivePath,
    archiveSha256: archive.sha256,
    platformMemberPrefix: "fixture",
    resumeCursor: providerArchiveCursorV2(0, 0),
    maximumChunkRecords: 1,
    maximumChunkBytes: 1024 * 1024,
  })) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map(({ hasMore }) => hasMore), [true, true, true, false]);
  assert.equal(chunks[0]?.requestedCursor, providerArchiveCursorV2(0, 0));
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index]?.requestedCursor, chunks[index - 1]?.nextCursor);
  }
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(
      chunk.payloadHash,
      createHash("sha256").update(archive.lines[index]!).digest("hex"),
    );
    assert.equal(chunk.uncompressedBytes, Buffer.byteLength(archive.lines[index]!));
    assert.equal(chunk.pageEvidence.uncompressedBytes, chunk.uncompressedBytes);
    assert.equal(JSON.stringify(chunk.pageEvidence).includes("record_id"), false);
  }

  const resumed = [];
  for await (const chunk of streamProviderArchiveV2({
    archivePath: archive.archivePath,
    archiveSha256: archive.sha256,
    platformMemberPrefix: "fixture",
    resumeCursor: chunks[1]!.nextCursor,
    maximumChunkRecords: 1,
  })) {
    resumed.push(chunk);
  }
  assert.deepEqual(
    resumed.flatMap(({ records }) => records).map(
      (value) => (value as { record_id: string }).record_id,
    ),
    ["pull-1", "trade-1"],
  );
});

test("archive reader rejects a cursor outside the stable four-member plan", async () => {
  await assert.rejects(
    async () => {
      for await (const chunk of streamProviderArchiveV2({
        archivePath: "/not-opened.zip",
        archiveSha256: "a".repeat(64),
        platformMemberPrefix: "fixture",
        resumeCursor: "archive-v2:4:0",
      })) {
        void chunk;
      }
    },
    /cursor is invalid/i,
  );
});

test("archive reader uses one immutable staged snapshot when the source changes mid-stream", async (context) => {
  const archive = await syntheticArchive();
  context.after(archive.cleanup);
  const iterator = streamProviderArchiveV2({
    archivePath: archive.archivePath,
    archiveSha256: archive.sha256,
    platformMemberPrefix: "fixture",
    resumeCursor: providerArchiveCursorV2(0, 0),
    maximumChunkRecords: 1,
  })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  const recordIds = first.done
    ? []
    : first.value.records.map((value) => (value as { record_id: string }).record_id);
  await appendFile(archive.archivePath, Buffer.from("changed"));
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    recordIds.push(
      ...next.value.records.map((value) =>
        (value as { record_id: string }).record_id,
      ),
    );
  }
  assert.deepEqual(recordIds, ["pack-1", "card-1", "pull-1", "trade-1"]);
  assert.notEqual(
    createHash("sha256").update(await readFile(archive.archivePath)).digest("hex"),
    archive.sha256,
  );
});

test("archive reader rejects source bytes that do not match the allowed digest", async (context) => {
  const archive = await syntheticArchive();
  context.after(archive.cleanup);
  await assert.rejects(async () => {
    for await (const chunk of streamProviderArchiveV2({
      archivePath: archive.archivePath,
      archiveSha256: "f".repeat(64),
      platformMemberPrefix: "fixture",
      resumeCursor: providerArchiveCursorV2(0, 0),
    })) {
      void chunk;
    }
  }, /allowed sha-256/i);
});

test("archive reader enforces compressed, record, and chunk resource ceilings", async (context) => {
  const archive = await syntheticArchive();
  context.after(archive.cleanup);
  const compressedBytes = (await readFile(archive.archivePath)).length;
  await assert.rejects(async () => {
    for await (const chunk of streamProviderArchiveV2({
      archivePath: archive.archivePath,
      archiveSha256: archive.sha256,
      platformMemberPrefix: "fixture",
      resumeCursor: providerArchiveCursorV2(0, 0),
      limits: { maximumCompressedBytes: compressedBytes - 1 },
    })) {
      void chunk;
    }
  }, /bounded regular file/i);
  await assert.rejects(async () => {
    for await (const chunk of streamProviderArchiveV2({
      archivePath: archive.archivePath,
      archiveSha256: archive.sha256,
      platformMemberPrefix: "fixture",
      resumeCursor: providerArchiveCursorV2(0, 0),
      maximumChunkRecords: 1,
      limits: { maximumRecords: 3 },
    })) {
      void chunk;
    }
  }, /streamed data limit/i);
  await assert.rejects(async () => {
    for await (const chunk of streamProviderArchiveV2({
      archivePath: archive.archivePath,
      archiveSha256: archive.sha256,
      platformMemberPrefix: "fixture",
      resumeCursor: providerArchiveCursorV2(0, 0),
      maximumChunkRecords: 1,
      limits: { maximumChunks: 3 },
    })) {
      void chunk;
    }
  }, /chunk limit/i);
});

test("archive unzip uses the trusted binary without inheriting importer secrets", { concurrency: false }, async (context) => {
  const archive = await syntheticArchive();
  const directory = await mkdtemp(join(tmpdir(), "packscout-unzip-hostile-path-"));
  const hostileUnzip = join(directory, "unzip");
  const marker = join(directory, "hostile-unzip-ran");
  const originalEnvironment = {
    PATH: process.env.PATH,
    PACKSCOUT_DATABASE_URL: process.env.PACKSCOUT_DATABASE_URL,
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64:
      process.env.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
    UNZIPOPT: process.env.UNZIPOPT,
  };
  context.after(async () => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await archive.cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    hostileUnzip,
    `#!/bin/sh\nprintf used > ${JSON.stringify(marker)}\nprintf 'hostile-output\\n'\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  process.env.PATH = `${directory}:${originalEnvironment.PATH ?? ""}`;
  process.env.PACKSCOUT_DATABASE_URL =
    "postgresql://secret-user:secret-password@127.0.0.1/packscout";
  process.env.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64 = "actor-secret";
  process.env.UNZIPOPT = "-qq";

  const childEnvironment = providerArchiveChildEnvironmentV2();
  assert.deepEqual(Object.keys(childEnvironment).sort(), ["LANG", "LC_ALL", "PATH"]);
  assert.equal(childEnvironment.PACKSCOUT_DATABASE_URL, undefined);
  assert.equal(childEnvironment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64, undefined);
  assert.equal(childEnvironment.UNZIPOPT, undefined);

  assert.deepEqual(
    await providerArchiveMembersV2({
      archivePath: archive.archivePath,
      platformMemberPrefix: "fixture",
    }),
    [
      "dataset/fixture_packs.ndjson",
      "dataset/fixture_cards.ndjson",
      "dataset/fixture_pulls.ndjson",
      "dataset/fixture_trades.ndjson",
    ],
  );
  assert.equal(await stat(marker).then(() => true, () => false), false);
});

test("trusted archive unzip children are terminated when inactive", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-unzip-inactive-"));
  const fifo = join(directory, "blocked.zip");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await execFileAsync("/usr/bin/mkfifo", [fifo]);
  await assert.rejects(
    providerArchiveMembersV2({
      archivePath: fifo,
      platformMemberPrefix: "fixture",
      limits: { childInactivityTimeoutMs: 25, maximumElapsedMs: 1_000 },
    }),
    /became inactive/i,
  );
});
