import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ProviderArchiveChunkV2 } from "./provider-archive-import-service.ts";

export const PROVIDER_ARCHIVE_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const PROVIDER_ARCHIVE_DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
export const PROVIDER_ARCHIVE_DEFAULT_CHUNK_RECORDS = 250;
export const PROVIDER_ARCHIVE_DEFAULT_LIMITS = {
  maximumCompressedBytes: 1024 * 1024 * 1024,
  maximumStreamBytes: 4 * 1024 * 1024 * 1024,
  maximumRecords: 1_000_000,
  maximumChunks: 10_000,
  maximumElapsedMs: 4 * 60 * 60 * 1_000,
  childInactivityTimeoutMs: 60_000,
} as const;
const maximumChildStderrBytes = 64 * 1024;
const childTerminationGraceMs = 1_000;
const memberKinds = ["packs", "cards", "pulls", "trades"] as const;
const cursorPattern = /^archive-v2:(\d+):(\d+)$/;
const trustedUnzipExecutable = "/usr/bin/unzip";
const trustedChildWorkingDirectory = "/";

/**
 * Archive children receive an allowlisted environment instead of inheriting the
 * importer process, which holds database and actor-pseudonym credentials.
 */
export function providerArchiveChildEnvironmentV2(): NodeJS.ProcessEnv {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
}

export interface ProviderArchiveReadLimitsV2 {
  readonly maximumCompressedBytes: number;
  readonly maximumStreamBytes: number;
  readonly maximumRecords: number;
  readonly maximumChunks: number;
  readonly maximumElapsedMs: number;
  readonly childInactivityTimeoutMs: number;
}

export interface StagedProviderArchiveV2 {
  readonly archivePath: string;
  readonly archiveSha256: string;
  cleanup(): Promise<void>;
}

export class ProviderArchiveReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderArchiveReaderError";
  }
}

function providerArchiveReadLimits(
  overrides: Partial<ProviderArchiveReadLimitsV2> | undefined,
): ProviderArchiveReadLimitsV2 {
  const limits = { ...PROVIDER_ARCHIVE_DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ProviderArchiveReaderError("Archive resource limits are invalid.");
    }
  }
  if (
    limits.maximumCompressedBytes > PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumCompressedBytes ||
    limits.maximumStreamBytes > PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumStreamBytes ||
    limits.maximumRecords > PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumRecords ||
    limits.maximumChunks > PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumChunks ||
    limits.maximumElapsedMs > PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumElapsedMs ||
    limits.childInactivityTimeoutMs >
      PROVIDER_ARCHIVE_DEFAULT_LIMITS.childInactivityTimeoutMs
  ) {
    throw new ProviderArchiveReaderError("Archive resource limits exceed safe ceilings.");
  }
  return limits;
}

export function providerArchiveCursorV2(memberIndex: number, nextLine: number): string {
  if (
    !Number.isSafeInteger(memberIndex) ||
    memberIndex < 0 ||
    memberIndex >= memberKinds.length ||
    !Number.isSafeInteger(nextLine) ||
    nextLine < 0
  ) {
    throw new ProviderArchiveReaderError("Archive cursor is invalid.");
  }
  return `archive-v2:${memberIndex}:${nextLine}`;
}

export function parseProviderArchiveCursorV2(cursor: string): {
  memberIndex: number;
  nextLine: number;
} {
  const match = cursorPattern.exec(cursor);
  const memberIndex = Number(match?.[1]);
  const nextLine = Number(match?.[2]);
  if (
    !match ||
    !Number.isSafeInteger(memberIndex) ||
    memberIndex < 0 ||
    memberIndex >= memberKinds.length ||
    !Number.isSafeInteger(nextLine) ||
    nextLine < 0
  ) {
    throw new ProviderArchiveReaderError("Archive resume cursor is invalid.");
  }
  return { memberIndex, nextLine };
}

function spawnBoundedUnzip(
  args: readonly string[],
  limits: ProviderArchiveReadLimitsV2,
  failureMessage: string,
) {
  const child = spawn(trustedUnzipExecutable, [...args], {
    cwd: trustedChildWorkingDirectory,
    env: providerArchiveChildEnvironmentV2(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failure: ProviderArchiveReaderError | null = null;
  let exitCode: number | null = null;
  let stderrBytes = 0;
  let inactivityTimer: NodeJS.Timeout;
  let killTimer: NodeJS.Timeout | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, childTerminationGraceMs);
  };
  const fail = (message: string) => {
    failure ??= new ProviderArchiveReaderError(message);
    terminate();
  };
  const resetInactivityTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () => fail("Archive extraction became inactive."),
      limits.childInactivityTimeoutMs,
    );
  };
  resetInactivityTimer();
  const executionTimer = setTimeout(
    () => fail("Archive extraction exceeded its elapsed-time limit."),
    limits.maximumElapsedMs,
  );
  child.stdout.on("data", resetInactivityTimer);
  child.stderr.on("data", (chunk: Buffer) => {
    resetInactivityTimer();
    stderrBytes += chunk.length;
    if (stderrBytes > maximumChildStderrBytes) {
      fail("Archive extraction produced excessive diagnostic output.");
    }
  });
  child.once("error", () => fail(failureMessage));
  child.once("close", (code) => {
    exitCode = code;
    clearTimeout(inactivityTimer);
    clearTimeout(executionTimer);
    if (killTimer) clearTimeout(killTimer);
    resolveClosed();
  });
  return {
    child,
    async finish(): Promise<void> {
      await closed;
      if (failure) throw failure;
      if (exitCode !== 0) throw new ProviderArchiveReaderError(failureMessage);
    },
    async stop(): Promise<void> {
      terminate();
      await closed;
    },
  };
}

async function collectChildStdout(
  args: readonly string[],
  limits: ProviderArchiveReadLimitsV2,
): Promise<string> {
  const process = spawnBoundedUnzip(args, limits, "Archive member listing failed.");
  const chunks: Buffer[] = [];
  let size = 0;
  process.child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size <= 1024 * 1024) chunks.push(chunk);
  });
  await process.finish();
  if (size > 1024 * 1024) {
    throw new ProviderArchiveReaderError("Archive member listing failed.");
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function stageProviderArchiveV2(input: {
  archivePath: string;
  archiveSha256: string;
  limits?: Partial<ProviderArchiveReadLimitsV2>;
}): Promise<StagedProviderArchiveV2> {
  const limits = providerArchiveReadLimits(input.limits);
  if (!/^[0-9a-f]{64}$/.test(input.archiveSha256)) {
    throw new ProviderArchiveReaderError("Archive SHA-256 is invalid.");
  }
  const sourcePath = resolve(input.archivePath);
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile() || sourceStat.size > limits.maximumCompressedBytes) {
    throw new ProviderArchiveReaderError("Archive source is not a bounded regular file.");
  }
  const directory = await mkdtemp(join(tmpdir(), "packscout-provider-archive-"));
  const stagedPath = join(directory, "source.zip");
  try {
    await copyFile(sourcePath, stagedPath);
    await chmod(stagedPath, 0o400);
    const stagedStat = await stat(stagedPath);
    if (
      !stagedStat.isFile() ||
      stagedStat.size > limits.maximumCompressedBytes ||
      (await sha256File(stagedPath)) !== input.archiveSha256
    ) {
      throw new ProviderArchiveReaderError(
        "Archive changed or does not match the allowed SHA-256.",
      );
    }
    return {
      archivePath: stagedPath,
      archiveSha256: input.archiveSha256,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof ProviderArchiveReaderError) throw error;
    throw new ProviderArchiveReaderError("Archive staging failed.");
  }
}

export async function providerArchiveMembersV2(input: {
  archivePath: string;
  platformMemberPrefix: string;
  limits?: Partial<ProviderArchiveReadLimitsV2>;
}): Promise<readonly string[]> {
  if (!/^[a-z0-9_]+$/.test(input.platformMemberPrefix)) {
    throw new ProviderArchiveReaderError("Archive platform member prefix is invalid.");
  }
  const limits = providerArchiveReadLimits(input.limits);
  const archivePath = resolve(input.archivePath);
  const listing = await collectChildStdout(["-Z1", archivePath], limits);
  const entries = listing.split("\n").filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some(
      (entry) =>
        entry.startsWith("/") ||
        entry.includes("\\") ||
        entry.split("/").includes("..") ||
        entry.includes("\0"),
    )
  ) {
    throw new ProviderArchiveReaderError("Archive contains an unsafe member path.");
  }
  return memberKinds.map((kind) => {
    const expected = `${input.platformMemberPrefix}_${kind}.ndjson`;
    const matches = entries.filter((entry) => basename(entry) === expected);
    if (matches.length !== 1) {
      throw new ProviderArchiveReaderError(
        `Archive must contain exactly one ${expected} member.`,
      );
    }
    return matches[0]!;
  });
}

interface ArchiveLine {
  readonly lineNumber: number;
  readonly rawBytes: Buffer;
  readonly record: unknown;
}

async function* readMemberLines(
  archivePath: string,
  member: string,
  limits: ProviderArchiveReadLimitsV2,
): AsyncIterable<ArchiveLine> {
  const process = spawnBoundedUnzip(
    ["-p", archivePath, member],
    limits,
    "Archive member extraction failed.",
  );
  const child = process.child;
  let buffered = Buffer.alloc(0);
  let lineNumber = 0;
  try {
    for await (const value of child.stdout) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        const rawBytes = buffered.subarray(0, newline + 1);
        if (rawBytes.length > PROVIDER_ARCHIVE_MAX_LINE_BYTES) {
          throw new ProviderArchiveReaderError("Archive record exceeds the 8 MiB line limit.");
        }
        const jsonBytes = rawBytes.subarray(
          0,
          rawBytes.length > 1 && rawBytes[rawBytes.length - 2] === 0x0d
            ? rawBytes.length - 2
            : rawBytes.length - 1,
        );
        let record: unknown;
        try {
          record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes));
        } catch {
          throw new ProviderArchiveReaderError("Archive contains invalid NDJSON.");
        }
        yield { lineNumber, rawBytes, record };
        lineNumber += 1;
        buffered = buffered.subarray(newline + 1);
        newline = buffered.indexOf(0x0a);
      }
      if (buffered.length > PROVIDER_ARCHIVE_MAX_LINE_BYTES) {
        throw new ProviderArchiveReaderError("Archive record exceeds the 8 MiB line limit.");
      }
    }
    if (buffered.length > 0) {
      let record: unknown;
      try {
        record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffered));
      } catch {
        throw new ProviderArchiveReaderError("Archive contains invalid NDJSON.");
      }
      yield { lineNumber, rawBytes: buffered, record };
    }
    await process.finish();
  } finally {
    if (child.exitCode === null && child.signalCode === null) await process.stop();
  }
}

interface ProviderArchiveStreamOptionsV2 {
  platformMemberPrefix: string;
  resumeCursor: string;
  maximumChunkBytes?: number;
  maximumChunkRecords?: number;
  limits?: Partial<ProviderArchiveReadLimitsV2>;
}

export async function* streamStagedProviderArchiveV2(
  input: ProviderArchiveStreamOptionsV2 & {
    stagedArchive: StagedProviderArchiveV2;
  },
): AsyncIterable<ProviderArchiveChunkV2> {
  const limits = providerArchiveReadLimits(input.limits);
  const archiveSha256 = input.stagedArchive.archiveSha256;
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new ProviderArchiveReaderError("Archive SHA-256 is invalid.");
  }
  const maximumChunkBytes =
    input.maximumChunkBytes ?? PROVIDER_ARCHIVE_DEFAULT_CHUNK_BYTES;
  const maximumChunkRecords =
    input.maximumChunkRecords ?? PROVIDER_ARCHIVE_DEFAULT_CHUNK_RECORDS;
  if (
    !Number.isSafeInteger(maximumChunkBytes) ||
    maximumChunkBytes < 1 ||
    maximumChunkBytes > PROVIDER_ARCHIVE_MAX_LINE_BYTES ||
    !Number.isSafeInteger(maximumChunkRecords) ||
    maximumChunkRecords < 1 ||
    maximumChunkRecords > 1_000
  ) {
    throw new ProviderArchiveReaderError("Archive chunk bounds are invalid.");
  }
  const resume = parseProviderArchiveCursorV2(input.resumeCursor);
  const archivePath = resolve(input.stagedArchive.archivePath);
  const startedAt = Date.now();
  const checkElapsed = () => {
    if (Date.now() - startedAt > limits.maximumElapsedMs) {
      throw new ProviderArchiveReaderError("Archive import exceeded its elapsed-time limit.");
    }
  };
  const stagedStat = await stat(archivePath).catch(() => null);
  if (
    !stagedStat?.isFile() ||
    stagedStat.size > limits.maximumCompressedBytes ||
    (await sha256File(archivePath)) !== archiveSha256
  ) {
    throw new ProviderArchiveReaderError(
      "Staged archive does not match the allowed SHA-256.",
    );
  }
  checkElapsed();
  const members = await providerArchiveMembersV2({
    archivePath,
    platformMemberPrefix: input.platformMemberPrefix,
    limits,
  });
  let streamedBytes = 0;
  let streamedRecords = 0;
  let createdChunks = 0;

  async function* chunks(): AsyncIterable<Omit<ProviderArchiveChunkV2, "hasMore">> {
    let requestedCursor = input.resumeCursor;
    for (let memberIndex = resume.memberIndex; memberIndex < members.length; memberIndex += 1) {
      const member = members[memberIndex]!;
      const firstLine = memberIndex === resume.memberIndex ? resume.nextLine : 0;
      let records: unknown[] = [];
      let rawBytes: Buffer[] = [];
      let byteCount = 0;
      let startLine = firstLine;
      let nextLine = firstLine;
      const flush = (): Omit<ProviderArchiveChunkV2, "hasMore"> | null => {
        if (records.length === 0) return null;
        createdChunks += 1;
        checkElapsed();
        if (createdChunks > limits.maximumChunks) {
          throw new ProviderArchiveReaderError("Archive exceeds the chunk limit.");
        }
        const nextCursor = providerArchiveCursorV2(memberIndex, nextLine);
        const chunk: Omit<ProviderArchiveChunkV2, "hasMore"> = {
          requestedCursor,
          nextCursor,
          records,
          uncompressedBytes: byteCount,
          payloadHash: createHash("sha256").update(Buffer.concat(rawBytes)).digest("hex"),
          pageEvidence: {
            format: "provider-archive-v2",
            archiveSha256,
            member,
            startLine,
            endLineExclusive: nextLine,
            recordCount: records.length,
            uncompressedBytes: byteCount,
          },
        };
        requestedCursor = nextCursor;
        records = [];
        rawBytes = [];
        byteCount = 0;
        startLine = nextLine;
        return chunk;
      };
      for await (const line of readMemberLines(archivePath, member, limits)) {
        streamedBytes += line.rawBytes.length;
        streamedRecords += 1;
        checkElapsed();
        if (
          streamedBytes > limits.maximumStreamBytes ||
          streamedRecords > limits.maximumRecords
        ) {
          throw new ProviderArchiveReaderError("Archive exceeds the streamed data limit.");
        }
        if (line.lineNumber < firstLine) continue;
        if (
          records.length > 0 &&
          (records.length >= maximumChunkRecords ||
            byteCount + line.rawBytes.length > maximumChunkBytes)
        ) {
          const chunk = flush();
          if (chunk) yield chunk;
        }
        records.push(line.record);
        rawBytes.push(line.rawBytes);
        byteCount += line.rawBytes.length;
        nextLine = line.lineNumber + 1;
      }
      const chunk = flush();
      if (chunk) yield chunk;
    }
  }

  let pending: Omit<ProviderArchiveChunkV2, "hasMore"> | null = null;
  for await (const chunk of chunks()) {
    if (pending) yield { ...pending, hasMore: true };
    pending = chunk;
  }
  if (pending) {
    checkElapsed();
    if ((await sha256File(archivePath)) !== archiveSha256) {
      throw new ProviderArchiveReaderError(
        "Staged archive no longer matches the allowed SHA-256.",
      );
    }
    yield { ...pending, hasMore: false };
  }
}

export async function* streamProviderArchiveV2(
  input: ProviderArchiveStreamOptionsV2 & {
    archivePath: string;
    archiveSha256: string;
  },
): AsyncIterable<ProviderArchiveChunkV2> {
  parseProviderArchiveCursorV2(input.resumeCursor);
  const staged = await stageProviderArchiveV2({
    archivePath: input.archivePath,
    archiveSha256: input.archiveSha256,
    limits: input.limits,
  });
  try {
    for await (const chunk of streamStagedProviderArchiveV2({
      stagedArchive: staged,
      platformMemberPrefix: input.platformMemberPrefix,
      resumeCursor: input.resumeCursor,
      maximumChunkBytes: input.maximumChunkBytes,
      maximumChunkRecords: input.maximumChunkRecords,
      limits: input.limits,
    })) {
      yield chunk;
    }
  } finally {
    await staged.cleanup();
  }
}
