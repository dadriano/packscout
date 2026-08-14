#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { safeValidateProviderStreamPageV2 } from "@packscout/contracts";
import {
  CatalogProjectionService,
  DefaultProviderImportPagePlanner,
  EventProjectionService,
  HmacProviderActorPseudonymizer,
  ProviderArchiveImportService,
  ProviderProjectionService,
  createProviderMappingAdapterRegistryFromManifest,
  providerArchiveCursorV2,
  stageProviderArchiveV2,
  streamStagedProviderArchiveV2,
  type ProviderImportRunSummary,
  type StagedProviderArchiveV2,
} from "@packscout/services";
import {
  IngestionPersistenceRepository,
  PrismaArchiveImportRepository,
  createPrismaClientLifecycle,
} from "@packscout/database";

interface CliOptions {
  archivePath: string;
  databaseUrl: string | null;
  organizationId: string;
  providerId: string;
  configurationRevisionId: string;
  platformKey: string;
  requestedByActorKey: string | null;
  workerId: string | null;
  allowedSha256: string;
  confirmedSha256: string | null;
  recoverFailedRunId: string | null;
  actorPseudonymKey: Uint8Array;
  dryRun: boolean;
}

const commonFlags = [
  "archive",
  "organization-id",
  "provider-id",
  "configuration-revision-id",
  "platform-key",
  "allow-archive-sha256",
] as const;
const commitFlags = ["requested-by-actor-key", "worker-id", "confirm-import"] as const;
const optionalCommitFlags = ["recover-failed-run"] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scopedValuePattern = /^[A-Za-z0-9:._-]{1,256}$/;
const platformPattern = /^[a-z0-9_]{1,128}$/;
const localDatabaseHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const systemDatabaseNames = new Set(["postgres", "template0", "template1"]);
const execFileAsync = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("../..", import.meta.url));
const trustedGitExecutable = "/usr/bin/git";

/** Git must not inherit database credentials, pseudonym keys, or repository redirects. */
export function archiveProvenanceChildEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
}

async function resolveArchiveGitLayout(workingDirectory: string): Promise<{
  canonicalWorkingDirectory: string;
  canonicalGitDirectory: string;
}> {
  const canonicalWorkingDirectory = await realpath(workingDirectory);
  const workingDirectoryStat = await stat(canonicalWorkingDirectory);
  if (
    !workingDirectoryStat.isDirectory() ||
    canonicalWorkingDirectory.includes("\0") ||
    /[\r\n]/.test(canonicalWorkingDirectory)
  ) {
    throw new Error("invalid working directory");
  }

  const gitEntryPath = join(canonicalWorkingDirectory, ".git");
  const gitEntryStat = await lstat(gitEntryPath);
  if (gitEntryStat.isSymbolicLink()) throw new Error("unsafe git entry");

  let gitDirectoryPath: string;
  if (gitEntryStat.isDirectory()) {
    gitDirectoryPath = gitEntryPath;
  } else if (gitEntryStat.isFile() && gitEntryStat.size <= 4_096) {
    const gitEntry = await readFile(gitEntryPath, "utf8");
    const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(gitEntry);
    if (!match) throw new Error("invalid git entry");
    gitDirectoryPath = resolve(canonicalWorkingDirectory, match[1]!);
  } else {
    throw new Error("invalid git entry");
  }

  const canonicalGitDirectory = await realpath(gitDirectoryPath);
  const gitDirectoryStat = await stat(canonicalGitDirectory);
  if (
    !gitDirectoryStat.isDirectory() ||
    canonicalGitDirectory.includes("\0") ||
    /[\r\n]/.test(canonicalGitDirectory)
  ) {
    throw new Error("invalid git directory");
  }
  return { canonicalWorkingDirectory, canonicalGitDirectory };
}

interface ArchiveHeadTreeEntry {
  readonly mode: "100644" | "100755" | "120000";
  readonly objectId: string;
  readonly path: string;
}

function parseArchiveHeadTree(
  listing: string,
  objectIdLength: number,
): readonly ArchiveHeadTreeEntry[] {
  const records = listing.split("\0");
  if (records.pop() !== "") throw new Error("invalid HEAD tree listing");
  const paths = new Set<string>();
  return records.map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 1) throw new Error("invalid HEAD tree entry");
    const header = record.slice(0, separator);
    const path = record.slice(separator + 1);
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]+)$/.exec(
      header,
    );
    if (
      !match ||
      match[1] === "160000" ||
      match[2] !== "blob" ||
      match[3]!.length !== objectIdLength ||
      !path ||
      path.startsWith("/") ||
      path.includes("\0") ||
      paths.has(path)
    ) {
      throw new Error("unsupported HEAD tree entry");
    }
    const components = path.split("/");
    if (
      components.some(
        (component) =>
          !component ||
          component === "." ||
          component === ".." ||
          component.toLowerCase() === ".git",
      )
    ) {
      throw new Error("unsafe HEAD tree path");
    }
    paths.add(path);
    return {
      mode: match[1] as ArchiveHeadTreeEntry["mode"],
      objectId: match[3]!,
      path,
    };
  });
}

async function trackedWorktreePath(
  canonicalWorkingDirectory: string,
  relativePath: string,
  verifiedDirectories: Set<string>,
): Promise<string> {
  const components = relativePath.split("/");
  let parent = canonicalWorkingDirectory;
  for (const component of components.slice(0, -1)) {
    parent = join(parent, component);
    if (verifiedDirectories.has(parent)) continue;
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error("tracked path parent is not a directory");
    }
    verifiedDirectories.add(parent);
  }
  return join(parent, components.at(-1)!);
}

function gitBlobHasher(
  objectFormat: "sha1" | "sha256",
  byteLength: number,
) {
  return createHash(objectFormat).update(`blob ${byteLength}\0`, "utf8");
}

async function requireTrackedWorktreeMatchesHead(input: {
  canonicalWorkingDirectory: string;
  objectFormat: "sha1" | "sha256";
  entries: readonly ArchiveHeadTreeEntry[];
}): Promise<void> {
  const verifiedDirectories = new Set([input.canonicalWorkingDirectory]);
  for (const entry of input.entries) {
    const path = await trackedWorktreePath(
      input.canonicalWorkingDirectory,
      entry.path,
      verifiedDirectories,
    );
    const pathStat = await lstat(path);
    let objectId: string;
    if (entry.mode === "120000") {
      if (!pathStat.isSymbolicLink()) throw new Error("tracked symlink type changed");
      const target = await readlink(path, { encoding: "buffer" });
      objectId = gitBlobHasher(input.objectFormat, target.length)
        .update(target)
        .digest("hex");
    } else {
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
        throw new Error("tracked file type changed");
      }
      const executable = (pathStat.mode & 0o111) !== 0;
      if ((entry.mode === "100755") !== executable) {
        throw new Error("tracked file mode changed");
      }
      const hash = gitBlobHasher(input.objectFormat, pathStat.size);
      let streamedBytes = 0;
      for await (const chunk of createReadStream(path)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        streamedBytes += bytes.length;
        hash.update(bytes);
      }
      if (streamedBytes !== pathStat.size) throw new Error("tracked file changed while read");
      const finalStat = await lstat(path);
      if (
        !finalStat.isFile() ||
        finalStat.isSymbolicLink() ||
        finalStat.size !== pathStat.size ||
        (finalStat.mode & 0o111) !== (pathStat.mode & 0o111)
      ) {
        throw new Error("tracked file changed while read");
      }
      objectId = hash.digest("hex");
    }
    if (objectId !== entry.objectId) throw new Error("tracked bytes differ from HEAD");
  }
}

export class ProviderArchiveTerminalStateError extends Error {
  readonly state: "failed" | "incomplete";

  constructor(state: "failed" | "incomplete") {
    super(`Provider archive import ended in ${state}.`);
    this.name = "ProviderArchiveTerminalStateError";
    this.state = state;
  }
}

export function writeProviderArchiveCommitSummary(input: {
  runId: string;
  state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  existing: boolean;
  counters?: ProviderImportRunSummary["counters"];
  recoveryRequired?: boolean;
}): void {
  process.stdout.write(
    `${JSON.stringify({
      mode: "commit",
      runId: input.runId,
      state: input.state,
      existing: input.existing,
      ...(input.counters ? { counters: input.counters } : {}),
      ...(input.recoveryRequired ? { recoveryRequired: true } : {}),
    })}\n`,
  );
  if (input.state === "failed" || input.state === "incomplete") {
    throw new ProviderArchiveTerminalStateError(input.state);
  }
}

function validateLocalDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PACKSCOUT_DATABASE_URL must be a valid local PostgreSQL URL.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !localDatabaseHosts.has(parsed.hostname) ||
    !databaseName ||
    databaseName.includes("/") ||
    systemDatabaseNames.has(databaseName.toLowerCase()) ||
    parsed.search !== ""
  ) {
    throw new Error("PACKSCOUT_DATABASE_URL must target a non-system loopback database.");
  }
  return value;
}

function flagValues(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Archive importer arguments must be --flag value pairs.");
    }
    const key = flag.slice(2);
    if (values.has(key)) throw new Error(`Duplicate --${key} argument.`);
    values.set(key, value);
  }
  return values;
}

export function parseProviderArchiveCliOptions(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const values = flagValues(argv);
  for (const flag of commonFlags) {
    if (!values.get(flag)?.trim()) throw new Error(`Missing required --${flag}.`);
  }
  const dryRun = values.get("dry-run") === "true";
  const allowed = new Set<string>(commonFlags);
  if (dryRun) allowed.add("dry-run");
  else {
    for (const flag of commitFlags) {
      allowed.add(flag);
      if (!values.get(flag)?.trim()) throw new Error(`Missing required --${flag}.`);
    }
    for (const flag of optionalCommitFlags) allowed.add(flag);
  }
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("Unknown archive importer argument.");
  }
  const allowedSha256 = values.get("allow-archive-sha256")!;
  const confirmedSha256 = values.get("confirm-import") ?? null;
  if (!/^[0-9a-f]{64}$/.test(allowedSha256)) {
    throw new Error("Archive SHA-256 allowlist value is invalid.");
  }
  if (!dryRun && confirmedSha256 !== allowedSha256) {
    throw new Error("--confirm-import must exactly match the allowed archive SHA-256.");
  }
  for (const flag of ["organization-id", "provider-id", "configuration-revision-id"]) {
    if (!uuidPattern.test(values.get(flag)!)) throw new Error(`Invalid --${flag}.`);
  }
  const recoverFailedRunId = values.get("recover-failed-run") ?? null;
  if (recoverFailedRunId !== null && !uuidPattern.test(recoverFailedRunId)) {
    throw new Error("Invalid --recover-failed-run.");
  }
  if (!platformPattern.test(values.get("platform-key")!)) {
    throw new Error("Platform scope is invalid.");
  }
  if (
    values.get("archive")!.length > 4_096 ||
    values.get("archive")!.includes("\0")
  ) {
    throw new Error("Archive path is invalid.");
  }
  if (
    !dryRun &&
    (!scopedValuePattern.test(values.get("requested-by-actor-key")!) ||
      !scopedValuePattern.test(values.get("worker-id")!))
  ) {
    throw new Error("Archive actor or worker scope is invalid.");
  }
  const actorKeyBase64 = environment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64;
  if (!actorKeyBase64) {
    throw new Error("PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64 is required.");
  }
  const actorPseudonymKey = Buffer.from(actorKeyBase64, "base64");
  if (
    actorPseudonymKey.length !== 32 ||
    actorPseudonymKey.toString("base64") !== actorKeyBase64
  ) {
    throw new Error("Actor pseudonym key must be canonical base64 for exactly 32 bytes.");
  }
  const configuredDatabaseUrl = environment.PACKSCOUT_DATABASE_URL ?? null;
  if (!dryRun && !configuredDatabaseUrl) {
    throw new Error("PACKSCOUT_DATABASE_URL is required.");
  }
  const databaseUrl = dryRun || !configuredDatabaseUrl
    ? null
    : validateLocalDatabaseUrl(configuredDatabaseUrl);
  return {
    archivePath: values.get("archive")!,
    databaseUrl,
    organizationId: values.get("organization-id")!,
    providerId: values.get("provider-id")!,
    configurationRevisionId: values.get("configuration-revision-id")!,
    platformKey: values.get("platform-key")!,
    requestedByActorKey: values.get("requested-by-actor-key") ?? null,
    workerId: values.get("worker-id") ?? null,
    allowedSha256,
    confirmedSha256,
    recoverFailedRunId,
    actorPseudonymKey,
    dryRun,
  };
}

function archiveMappingRuntime(actorPseudonymKey: Uint8Array, platformKey: string) {
  const mappings = createProviderMappingAdapterRegistryFromManifest();
  const mappingAdapterKey = mappings.resolveForPlatform(platformKey).key;
  return {
    mappingAdapterKey,
    planner: new DefaultProviderImportPagePlanner(
      mappings,
      new ProviderProjectionService(
        new CatalogProjectionService(),
        new EventProjectionService(
          new HmacProviderActorPseudonymizer(actorPseudonymKey),
        ),
      ),
    ),
  };
}

export async function resolveArchiveImporterBuildSha(
  workingDirectory = projectDirectory,
): Promise<string> {
  try {
    const { canonicalWorkingDirectory, canonicalGitDirectory } =
      await resolveArchiveGitLayout(workingDirectory);
    const gitScopeArguments = [
      `--git-dir=${canonicalGitDirectory}`,
      `--work-tree=${canonicalWorkingDirectory}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
    ] as const;
    const childOptions = {
      cwd: canonicalWorkingDirectory,
      env: archiveProvenanceChildEnvironment(),
    } as const;
    const topLevel = await execFileAsync(
      trustedGitExecutable,
      [...gitScopeArguments, "rev-parse", "--show-toplevel"],
      { ...childOptions, maxBuffer: 4_096 },
    );
    const canonicalTopLevel = await realpath(topLevel.stdout.trim());
    if (canonicalTopLevel !== canonicalWorkingDirectory) {
      throw new Error("redirected work tree");
    }
    const requireVisibleTrackedIndex = async (): Promise<void> => {
      const trackedIndex = await execFileAsync(
        trustedGitExecutable,
        [...gitScopeArguments, "ls-files", "-v", "-z"],
        { ...childOptions, maxBuffer: 4 * 1024 * 1024 },
      );
      const entries = trackedIndex.stdout.split("\0");
      if (entries.pop() !== "" || entries.some((entry) => !entry.startsWith("H "))) {
        throw new Error("tracked index entry is hidden");
      }
    };
    await requireVisibleTrackedIndex();
    const objectFormatResult = await execFileAsync(
      trustedGitExecutable,
      [...gitScopeArguments, "rev-parse", "--show-object-format"],
      { ...childOptions, maxBuffer: 128 },
    );
    const objectFormat = objectFormatResult.stdout.trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      throw new Error("unsupported Git object format");
    }
    const revision = await execFileAsync(
      trustedGitExecutable,
      [...gitScopeArguments, "rev-parse", "--verify", "HEAD"],
      {
        ...childOptions,
        maxBuffer: 1024,
      },
    );
    const sha = revision.stdout.trim();
    const objectIdLength = objectFormat === "sha1" ? 40 : 64;
    if (!new RegExp(`^[0-9a-f]{${objectIdLength}}$`).test(sha)) {
      throw new Error("invalid revision");
    }
    await execFileAsync(
      trustedGitExecutable,
      [
        ...gitScopeArguments,
        "diff-index",
        "--cached",
        "--quiet",
        "--no-ext-diff",
        sha,
        "--",
      ],
      { ...childOptions, maxBuffer: 4_096 },
    );
    const untracked = await execFileAsync(
      trustedGitExecutable,
      [
        ...gitScopeArguments,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { ...childOptions, maxBuffer: 1024 * 1024 },
    );
    if (untracked.stdout.length > 0) throw new Error("untracked files are present");
    await requireVisibleTrackedIndex();
    const tree = await execFileAsync(
      trustedGitExecutable,
      [...gitScopeArguments, "ls-tree", "-r", "-z", "--full-tree", sha],
      { ...childOptions, maxBuffer: 32 * 1024 * 1024 },
    );
    await requireTrackedWorktreeMatchesHead({
      canonicalWorkingDirectory,
      objectFormat,
      entries: parseArchiveHeadTree(tree.stdout, objectIdLength),
    });
    return sha;
  } catch {
    throw new Error("Archive commit import requires a clean pinned Git revision.");
  }
}

async function runDryRun(
  options: CliOptions,
  stagedArchive: StagedProviderArchiveV2,
): Promise<void> {
  const { planner } = archiveMappingRuntime(
    options.actorPseudonymKey,
    options.platformKey,
  );
  const counts = { chunks: 0, records: 0, catalog: 0, pulls: 0, trades: 0, quarantined: 0 };
  for await (const chunk of streamStagedProviderArchiveV2({
    stagedArchive,
    platformMemberPrefix: options.platformKey,
    resumeCursor: providerArchiveCursorV2(0, 0),
  })) {
    const validated = safeValidateProviderStreamPageV2({
      rawPage: chunk.pageEvidence,
      normalizedPage: {
        requestedCursor: chunk.requestedCursor,
        nextCursor: chunk.nextCursor,
        hasMore: chunk.hasMore,
        records: chunk.records,
      },
      context: {
        requestedPlatform: options.platformKey,
        requestedCursor: chunk.requestedCursor,
      },
    });
    if (!validated.success) throw new Error("Archive failed V2 contract validation.");
    const planned = await planner.plan({
      configuration: {
        providerId: options.providerId,
        configurationRevisionId: options.configurationRevisionId,
        platform: options.platformKey,
        adapterKey: "archive-dry-run",
      },
      page: validated.data,
    });
    counts.chunks += 1;
    counts.records += chunk.records.length;
    counts.catalog += planned.records.filter(({ recordKind }) => recordKind === "catalog").length;
    counts.pulls += planned.records.filter(({ recordKind }) => recordKind === "pull").length;
    counts.trades += planned.records.filter(({ recordKind }) => recordKind === "trade").length;
    counts.quarantined +=
      planned.quarantines.length + planned.records.filter(({ quarantine }) => quarantine).length;
  }
  if (counts.chunks === 0) throw new Error("Archive contained no import chunks.");
  process.stdout.write(
    `${JSON.stringify({ mode: "dry-run", archiveSha256: stagedArchive.archiveSha256, ...counts })}\n`,
  );
}

async function runCommit(
  options: CliOptions,
  stagedArchive: StagedProviderArchiveV2,
): Promise<void> {
  const archiveSha256 = stagedArchive.archiveSha256;
  const archiveImporterBuildSha = await resolveArchiveImporterBuildSha();
  const lifecycle = createPrismaClientLifecycle({ databaseUrl: options.databaseUrl! });
  try {
    await lifecycle.start();
    const mapping = archiveMappingRuntime(
      options.actorPseudonymKey,
      options.platformKey,
    );
    const archives = new PrismaArchiveImportRepository(lifecycle.client);
    const actorPseudonymKeyFingerprint = createHash("sha256")
      .update(options.actorPseudonymKey)
      .digest("hex");
    const pages = new IngestionPersistenceRepository(lifecycle.client, {
      retentionDays: 90,
      actorPseudonymKey: options.actorPseudonymKey,
    });
    const service = new ProviderArchiveImportService({
      archives,
      runs: archives,
      pages,
      pagePlanner: mapping.planner,
      clock: { now: () => new Date() },
      ids: { id: randomUUID },
    });
    let request: { run: ProviderImportRunSummary; existing: boolean };
    if (options.recoverFailedRunId !== null) {
      const preflight = await archives.preflightArchiveRecovery({
        organizationId: options.organizationId,
        providerId: options.providerId,
        configurationRevisionId: options.configurationRevisionId,
        runId: options.recoverFailedRunId,
        platformKey: options.platformKey,
        mappingAdapterKey: mapping.mappingAdapterKey,
        actorPseudonymKeyFingerprint,
        archiveImporterBuildSha,
        archiveSha256,
      });
      if (preflight.kind !== "ready") {
        throw new Error("Archive recovery preflight did not match a recoverable operation.");
      }
      await service.recoverFailedArchive({
        organizationId: options.organizationId,
        providerId: options.providerId,
        runId: preflight.run.id,
        archiveSha256,
        requestedByActorKey: options.requestedByActorKey!,
      });
      const recoveredRun = await archives.getRun(
        options.organizationId,
        preflight.run.id,
      );
      if (!recoveredRun) throw new Error("Recovered archive operation is unavailable.");
      request = { run: recoveredRun, existing: true };
    } else {
      await service.ensureArchiveRevision({
        organizationId: options.organizationId,
        providerId: options.providerId,
        configurationRevisionId: options.configurationRevisionId,
        platformKey: options.platformKey,
        mappingAdapterKey: mapping.mappingAdapterKey,
        actorPseudonymKeyFingerprint,
        archiveImporterBuildSha,
        archiveSha256,
        requestedByActorKey: options.requestedByActorKey!,
      });
      request = await service.requestArchive({
        organizationId: options.organizationId,
        providerId: options.providerId,
        configurationRevisionId: options.configurationRevisionId,
        archiveSha256,
        requestedByActorKey: options.requestedByActorKey!,
        initialCursor: providerArchiveCursorV2(0, 0),
      });
      if (request.existing && request.run.state === "failed") {
        writeProviderArchiveCommitSummary({
          runId: request.run.id,
          state: request.run.state,
          existing: true,
          counters: request.run.counters,
          recoveryRequired: true,
        });
      }
    }
    if (request.existing && ["succeeded", "incomplete"].includes(request.run.state)) {
      writeProviderArchiveCommitSummary({
        runId: request.run.id,
        state: request.run.state,
        existing: true,
        counters: request.run.counters,
      });
      return;
    }
    const run = await service.executeArchive({
      organizationId: options.organizationId,
      runId: request.run.id,
      workerId: options.workerId!,
      chunks: (resumeCursor) =>
        streamStagedProviderArchiveV2({
          stagedArchive,
          platformMemberPrefix: options.platformKey,
          resumeCursor,
        }),
    });
    writeProviderArchiveCommitSummary({
      runId: run.id,
      state: run.state,
      existing: request.existing,
      counters: run.counters,
    });
  } finally {
    await lifecycle.close();
  }
}

export async function runProviderArchiveImport(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseProviderArchiveCliOptions(argv, environment);
  const archiveStat = await stat(options.archivePath).catch(() => null);
  if (!archiveStat?.isFile()) throw new Error("Archive path is not a regular file.");
  const stagedArchive = await stageProviderArchiveV2({
    archivePath: options.archivePath,
    archiveSha256: options.allowedSha256,
  });
  try {
    if (options.dryRun) await runDryRun(options, stagedArchive);
    else await runCommit(options, stagedArchive);
  } finally {
    await stagedArchive.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runProviderArchiveImport(process.argv.slice(2)).catch((error: unknown) => {
    if (!(error instanceof ProviderArchiveTerminalStateError)) {
      process.stderr.write("Provider archive import failed.\n");
    }
    process.exitCode = 1;
  });
}
