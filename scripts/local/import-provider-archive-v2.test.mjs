import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = resolve("scripts/local/import-provider-archive-v2.ts");
const {
  archiveProvenanceChildEnvironment,
  resolveArchiveImporterBuildSha,
} = await import(pathToFileURL(script).href);
const digest = "a".repeat(64);
const common = [
  "--archive",
  "/does/not/matter.zip",
  "--organization-id",
  "10000000-0000-4000-8000-000000000001",
  "--provider-id",
  "10000000-0000-4000-8000-000000000002",
  "--configuration-revision-id",
  "10000000-0000-4000-8000-000000000003",
  "--platform-key",
  "collector_crypt",
  "--allow-archive-sha256",
  digest,
  "--dry-run",
  "true",
];

test("archive CLI rejects secret flags and never echoes configured secret values", () => {
  const databaseSecret = "postgresql://secret-user:secret-password@localhost/packscout";
  const actorSecret = Buffer.alloc(32, 7).toString("base64");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...common, "--database-url", databaseSecret],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PACKSCOUT_DATABASE_URL: databaseSecret,
        PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorSecret,
      },
    },
  );
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(output.includes(databaseSecret), false);
  assert.equal(output.includes(actorSecret), false);
  assert.match(output, /Provider archive import failed/);
});

test("archive CLI rejects a caller-controlled platform member prefix", () => {
  const result = parseInChild(
    [...common, "--platform-member-prefix", "courtyard"],
    {
      PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: Buffer.alloc(32, 8).toString("base64"),
    },
  );
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /unknown archive importer argument/i);
});

test("archive CLI requires one canonical 32-byte actor pseudonym key", () => {
  const canonical = Buffer.alloc(32, 6).toString("base64");
  for (const actorKey of [
    "not-base64",
    Buffer.alloc(33, 6).toString("base64"),
    canonical.replace(/=+$/, ""),
  ]) {
    const result = parseInChild(common, {
      PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorKey,
    });
    assert.equal(result.status, 2);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /canonical base64 for exactly 32 bytes/i,
    );
  }
});

test("archive importer provenance ignores hostile Git redirects and excludes importer secrets", { concurrency: false }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-archive-git-"));
  const trustedRepository = join(directory, "trusted");
  const redirectedRepository = join(directory, "redirected");
  const hostileBin = join(directory, "hostile-bin");
  const hostileGitMarker = join(directory, "hostile-git-ran");
  const fsmonitorHook = join(directory, "hostile-fsmonitor");
  const fsmonitorMarker = join(directory, "hostile-fsmonitor-ran");
  const gitTrace = join(directory, "git-trace");
  await mkdir(trustedRepository);
  await mkdir(redirectedRepository);
  await mkdir(hostileBin);
  const originalEnvironment = {
    PATH: process.env.PATH,
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    GIT_TRACE: process.env.GIT_TRACE,
    PACKSCOUT_DATABASE_URL: process.env.PACKSCOUT_DATABASE_URL,
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64:
      process.env.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
  };
  context.after(async () => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  for (const [repository, commitMessage] of [
    [trustedRepository, "trusted fixture"],
    [redirectedRepository, "redirected fixture"],
  ]) {
    assert.equal(spawnSync("/usr/bin/git", ["init", "-q"], { cwd: repository }).status, 0);
    await writeFile(join(repository, "tracked.txt"), "trusted\n", "utf8");
    assert.equal(
      spawnSync("/usr/bin/git", ["add", "tracked.txt"], { cwd: repository }).status,
      0,
    );
    assert.equal(
      spawnSync(
        "/usr/bin/git",
        [
          "-c", "user.name=PackScout Test",
          "-c", "user.email=packscout@example.invalid",
          "commit", "-qm", commitMessage,
        ],
        { cwd: repository },
      ).status,
      0,
    );
  }
  const trustedSha = spawnSync(
    "/usr/bin/git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: trustedRepository, encoding: "utf8" },
  ).stdout.trim();
  const redirectedSha = spawnSync(
    "/usr/bin/git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: redirectedRepository, encoding: "utf8" },
  ).stdout.trim();
  assert.notEqual(trustedSha, redirectedSha);
  await writeFile(
    join(hostileBin, "git"),
    `#!/bin/sh\nprintf used > ${JSON.stringify(hostileGitMarker)}\nprintf '${"f".repeat(40)}\\n'\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  process.env.PATH = `${hostileBin}:${originalEnvironment.PATH ?? ""}`;
  process.env.GIT_DIR = join(redirectedRepository, ".git");
  process.env.GIT_WORK_TREE = redirectedRepository;
  process.env.GIT_INDEX_FILE = join(redirectedRepository, ".git", "index");
  process.env.GIT_TRACE = gitTrace;
  process.env.PACKSCOUT_DATABASE_URL =
    "postgresql://secret-user:secret-password@127.0.0.1/packscout";
  process.env.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64 = "actor-secret";

  const childEnvironment = archiveProvenanceChildEnvironment();
  assert.equal(childEnvironment.GIT_DIR, undefined);
  assert.equal(childEnvironment.GIT_WORK_TREE, undefined);
  assert.equal(childEnvironment.GIT_INDEX_FILE, undefined);
  assert.equal(childEnvironment.GIT_TRACE, undefined);
  assert.equal(childEnvironment.PACKSCOUT_DATABASE_URL, undefined);
  assert.equal(childEnvironment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64, undefined);
  assert.equal(await resolveArchiveImporterBuildSha(trustedRepository), trustedSha);
  assert.equal(await stat(hostileGitMarker).then(() => true, () => false), false);
  assert.equal(await stat(gitTrace).then(() => true, () => false), false);

  const trustedGitConfig = join(trustedRepository, ".git", "config");
  const isolatedGitEnvironment = {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
  };
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["config", "--file", trustedGitConfig, "core.worktree", redirectedRepository],
      { env: isolatedGitEnvironment },
    ).status,
    0,
  );
  const vulnerableTopLevel = spawnSync(
    "/usr/bin/git",
    [`--git-dir=${join(trustedRepository, ".git")}`, "rev-parse", "--show-toplevel"],
    { cwd: trustedRepository, encoding: "utf8", env: isolatedGitEnvironment },
  );
  assert.equal(vulnerableTopLevel.status, 0);
  assert.equal(
    await realpath(vulnerableTopLevel.stdout.trim()),
    await realpath(redirectedRepository),
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      [
        `--git-dir=${join(trustedRepository, ".git")}`,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ],
      { cwd: trustedRepository, encoding: "utf8", env: isolatedGitEnvironment },
    ).stdout,
    "",
  );
  await writeFile(
    fsmonitorHook,
    `#!/bin/sh\nprintf used > ${JSON.stringify(fsmonitorMarker)}\nprintf '{}\\n'\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["config", "--file", trustedGitConfig, "core.fsmonitor", fsmonitorHook],
      { env: isolatedGitEnvironment },
    ).status,
    0,
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["config", "--file", trustedGitConfig, "core.untrackedCache", "true"],
      { env: isolatedGitEnvironment },
    ).status,
    0,
  );
  await appendFile(join(trustedRepository, "tracked.txt"), "dirty\n", "utf8");
  await assert.rejects(
    resolveArchiveImporterBuildSha(trustedRepository),
    /clean pinned Git revision/i,
  );
  assert.equal(await stat(fsmonitorMarker).then(() => true, () => false), false);
});

test("archive importer build provenance requires one clean pinned Git revision", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-archive-clean-git-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("/usr/bin/git", ["init", "-q"], { cwd: directory }).status, 0);
  await writeFile(join(directory, "tracked.txt"), "clean\n", "utf8");
  assert.equal(spawnSync("/usr/bin/git", ["add", "tracked.txt"], { cwd: directory }).status, 0);
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      [
        "-c", "user.name=PackScout Test",
        "-c", "user.email=packscout@example.invalid",
        "commit", "-qm", "fixture",
      ],
      { cwd: directory },
    ).status,
    0,
  );
  assert.match(await resolveArchiveImporterBuildSha(directory), /^[0-9a-f]{40}$/);
  const untrackedPath = join(directory, "untracked.txt");
  await writeFile(untrackedPath, "untracked\n", "utf8");
  await assert.rejects(
    resolveArchiveImporterBuildSha(directory),
    /clean pinned Git revision/i,
  );
  await rm(untrackedPath, { force: true });
  await appendFile(join(directory, "tracked.txt"), "dirty\n", "utf8");
  await assert.rejects(
    resolveArchiveImporterBuildSha(directory),
    /clean pinned Git revision/i,
  );
});

test("archive importer rejects tracked files hidden by Git index flags", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-archive-index-flags-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("/usr/bin/git", ["init", "-q"], { cwd: directory }).status, 0);
  await writeFile(join(directory, "tracked.ts"), "export const value = 1;\n", "utf8");
  assert.equal(spawnSync("/usr/bin/git", ["add", "tracked.ts"], { cwd: directory }).status, 0);
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      [
        "-c", "user.name=PackScout Test",
        "-c", "user.email=packscout@example.invalid",
        "commit", "-qm", "fixture",
      ],
      { cwd: directory },
    ).status,
    0,
  );
  const head = await resolveArchiveImporterBuildSha(directory);

  for (const [enableFlag, disableFlag] of [
    ["--assume-unchanged", "--no-assume-unchanged"],
    ["--skip-worktree", "--no-skip-worktree"],
  ]) {
    assert.equal(
      spawnSync(
        "/usr/bin/git",
        ["update-index", enableFlag, "tracked.ts"],
        { cwd: directory },
      ).status,
      0,
    );
    await writeFile(join(directory, "tracked.ts"), "export const value = 2;\n", "utf8");
    const hiddenStatus = spawnSync(
      "/usr/bin/git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(hiddenStatus.status, 0);
    assert.equal(hiddenStatus.stdout, "");
    await assert.rejects(
      resolveArchiveImporterBuildSha(directory),
      /clean pinned Git revision/i,
    );
    assert.equal(
      spawnSync(
        "/usr/bin/git",
        ["update-index", disableFlag, "tracked.ts"],
        { cwd: directory },
      ).status,
      0,
    );
    await writeFile(join(directory, "tracked.ts"), "export const value = 1;\n", "utf8");
    assert.equal(await resolveArchiveImporterBuildSha(directory), head);
  }
});

test("archive importer hashes raw tracked bytes independently of local clean filters", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-archive-clean-filter-"));
  const cleanFilter = join(directory, ".git", "conceal-clean-filter");
  const filterInvocationMarker = join(directory, ".git", "conceal-clean-filter-ran");
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("/usr/bin/git", ["init", "-q"], { cwd: directory }).status, 0);
  await writeFile(
    cleanFilter,
    [
      "#!/bin/sh",
      "/bin/cat >/dev/null",
      `printf ran > ${JSON.stringify(filterInvocationMarker)}`,
      "printf 'export const value = 1;\\n'",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await writeFile(
    join(directory, ".git", "info", "attributes"),
    "tracked.ts filter=conceal\n",
    "utf8",
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["config", "filter.conceal.clean", cleanFilter],
      { cwd: directory },
    ).status,
    0,
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["config", "filter.conceal.required", "true"],
      { cwd: directory },
    ).status,
    0,
  );
  await writeFile(join(directory, "tracked.ts"), "export const value = 1;\n", "utf8");
  assert.equal(spawnSync("/usr/bin/git", ["add", "tracked.ts"], { cwd: directory }).status, 0);
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      [
        "-c", "user.name=PackScout Test",
        "-c", "user.email=packscout@example.invalid",
        "commit", "-qm", "fixture",
      ],
      { cwd: directory },
    ).status,
    0,
  );
  const head = await resolveArchiveImporterBuildSha(directory);
  await writeFile(join(directory, "tracked.ts"), "export const value = 200;\n", "utf8");
  assert.equal(spawnSync("/usr/bin/git", ["add", "tracked.ts"], { cwd: directory }).status, 0);
  assert.equal(
    spawnSync("/usr/bin/git", ["check-attr", "filter", "--", "tracked.ts"], {
      cwd: directory,
      encoding: "utf8",
    }).stdout.trim(),
    "tracked.ts: filter: conceal",
  );
  assert.equal(
    spawnSync("/usr/bin/git", ["hash-object", "tracked.ts"], {
      cwd: directory,
      encoding: "utf8",
    }).stdout.trim(),
    spawnSync("/usr/bin/git", ["rev-parse", `${head}:tracked.ts`], {
      cwd: directory,
      encoding: "utf8",
    }).stdout.trim(),
  );
  const hiddenStatus = spawnSync(
    "/usr/bin/git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(hiddenStatus.status, 0);
  assert.equal(hiddenStatus.stdout, "");
  assert.equal(
    spawnSync("/usr/bin/git", ["ls-files", "-v", "--", "tracked.ts"], {
      cwd: directory,
      encoding: "utf8",
    }).stdout.trim(),
    "H tracked.ts",
  );
  await rm(filterInvocationMarker, { force: true });
  assert.equal(await stat(filterInvocationMarker).then(() => true, () => false), false);
  await assert.rejects(
    resolveArchiveImporterBuildSha(directory),
    /clean pinned Git revision/i,
  );
  assert.equal(await stat(filterInvocationMarker).then(() => true, () => false), false);
});

test("archive importer does not execute self-mutating clean filters", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-archive-mutating-filter-"));
  const source = join(directory, "self-mutating.ts");
  const cleanFilter = join(directory, ".git", "self-mutating-clean-filter");
  const armedMarker = join(directory, ".git", "arm-self-mutation");
  const filterInvocationMarker = join(directory, ".git", "self-mutating-filter-ran");
  const originalSource = "export const value = 1;\n";
  const compromisedSource = "export const value = 999;\n";
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("/usr/bin/git", ["init", "-q"], { cwd: directory }).status, 0);
  await writeFile(
    cleanFilter,
    [
      "#!/bin/sh",
      "/bin/cat >/dev/null",
      `printf ran > ${JSON.stringify(filterInvocationMarker)}`,
      `if [ -f ${JSON.stringify(armedMarker)} ]; then`,
      `  printf ${JSON.stringify(compromisedSource)} > ${JSON.stringify(source)}`,
      "fi",
      `printf ${JSON.stringify(originalSource)}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await writeFile(
    join(directory, ".git", "info", "attributes"),
    "self-mutating.ts filter=self-mutate\n",
    "utf8",
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["config", "filter.self-mutate.clean", cleanFilter],
      { cwd: directory },
    ).status,
    0,
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["config", "filter.self-mutate.required", "true"],
      { cwd: directory },
    ).status,
    0,
  );
  await writeFile(source, originalSource, "utf8");
  assert.equal(
    spawnSync("/usr/bin/git", ["add", "self-mutating.ts"], { cwd: directory }).status,
    0,
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      [
        "-c", "user.name=PackScout Test",
        "-c", "user.email=packscout@example.invalid",
        "commit", "-qm", "fixture",
      ],
      { cwd: directory },
    ).status,
    0,
  );
  const head = await resolveArchiveImporterBuildSha(directory);
  assert.match(head, /^[0-9a-f]{40}$/);
  await rm(filterInvocationMarker, { force: true });
  await writeFile(armedMarker, "armed\n", "utf8");
  const future = new Date(Date.now() + 60_000);
  await utimes(source, future, future);

  assert.equal(await resolveArchiveImporterBuildSha(directory), head);
  assert.equal(await readFile(source, "utf8"), originalSource);
  assert.equal(await stat(filterInvocationMarker).then(() => true, () => false), false);
  const hiddenStatus = spawnSync(
    "/usr/bin/git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(hiddenStatus.status, 0);
  assert.equal(hiddenStatus.stdout, "");
  assert.equal(await readFile(source, "utf8"), compromisedSource);
  assert.equal(await stat(filterInvocationMarker).then(() => true, () => false), true);
});

test("archive importer verifies tracked executable modes and raw symlink targets", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-archive-file-modes-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("/usr/bin/git", ["init", "-q"], { cwd: directory }).status, 0);
  await writeFile(join(directory, "target.txt"), "target\n", "utf8");
  await writeFile(join(directory, "executable.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(directory, "executable.sh"), 0o755);
  await symlink("target.txt", join(directory, "target-link"));
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["add", "target.txt", "executable.sh", "target-link"],
      { cwd: directory },
    ).status,
    0,
  );
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      [
        "-c", "user.name=PackScout Test",
        "-c", "user.email=packscout@example.invalid",
        "commit", "-qm", "fixture",
      ],
      { cwd: directory },
    ).status,
    0,
  );
  const head = await resolveArchiveImporterBuildSha(directory);
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(
    spawnSync("/usr/bin/git", ["config", "core.fileMode", "false"], {
      cwd: directory,
    }).status,
    0,
  );
  await chmod(join(directory, "executable.sh"), 0o644);
  assert.equal(
    spawnSync(
      "/usr/bin/git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { cwd: directory, encoding: "utf8" },
    ).stdout,
    "",
  );
  await assert.rejects(
    resolveArchiveImporterBuildSha(directory),
    /clean pinned Git revision/i,
  );
  await chmod(join(directory, "executable.sh"), 0o755);
  assert.equal(await resolveArchiveImporterBuildSha(directory), head);
});

function parseInChild(argv, environment) {
  const program = `
    import { parseProviderArchiveCliOptions } from ${JSON.stringify(pathToFileURL(script).href)};
    try {
      parseProviderArchiveCliOptions(${JSON.stringify(argv)}, process.env);
      process.stdout.write("accepted");
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : "invalid");
      process.exitCode = 2;
    }
  `;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...environment } },
  );
}

const commitArguments = [
  ...common.slice(0, -2),
  "--requested-by-actor-key",
  "operator:archive",
  "--worker-id",
  "archive-worker",
  "--confirm-import",
  digest,
];

test("local archive CLI rejects non-loopback and system database targets without echoing them", () => {
  const actorSecret = Buffer.alloc(32, 9).toString("base64");
  for (const databaseUrl of [
    "postgresql://secret-user:secret-password@database.example/packscout",
    "postgresql://secret-user:secret-password@127.0.0.1/postgres",
    "postgresql://secret-user:secret-password@LOCALHOST/%50oStGrEs",
    "postgresql://secret-user:secret-password@127.0.0.1/packscout?host=database.example",
  ]) {
    const result = parseInChild(commitArguments, {
      PACKSCOUT_DATABASE_URL: databaseUrl,
      PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorSecret,
    });
    assert.equal(result.status, 2);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /non-system loopback database/i);
    assert.equal(output.includes(databaseUrl), false);
    assert.equal(output.includes(actorSecret), false);
  }
});

test("archive CLI emits one bounded summary and exits nonzero for failed or incomplete", () => {
  for (const state of ["failed", "incomplete"]) {
    const program = `
      import {
        ProviderArchiveTerminalStateError,
        writeProviderArchiveCommitSummary,
      } from ${JSON.stringify(pathToFileURL(script).href)};
      try {
        writeProviderArchiveCommitSummary({
          runId: "10000000-0000-4000-8000-000000000099",
          state: ${JSON.stringify(state)},
          existing: false,
          counters: {
            accepted: 1,
            duplicate: 2,
            quarantined: 3,
            pages: 4,
            records: 5,
            requestAttempts: 0,
            transientRetries: 0,
          },
        });
      } catch (error) {
        if (!(error instanceof ProviderArchiveTerminalStateError)) throw error;
        process.exitCode = 1;
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", program],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.length < 512, true);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, "commit");
    assert.equal(summary.state, state);
    assert.equal(summary.counters.quarantined, 3);
  }
});

test("archive CLI dry-run streams V2 records without opening a database or printing evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "packscout-cli-dry-run-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dataset = join(directory, "dataset");
  await mkdir(dataset);
  const timestamp = "2026-08-13T00:00:00.000Z";
  const commonRecord = {
    platform: "collector_crypt",
    occurred_at: timestamp,
    collected_at: timestamp,
    data: { private_marker: "must-not-print" },
  };
  const records = [
    {
      ...commonRecord,
      stream: "catalog",
      entity: "pack",
      record_id: "private-pack",
      first_seen_at: timestamp,
    },
    {
      ...commonRecord,
      stream: "catalog",
      entity: "card",
      record_id: "private-card",
      first_seen_at: timestamp,
    },
    {
      ...commonRecord,
      stream: "pulls",
      record_id: "private-pull",
      pack_id: "private-pack",
      card_id: "private-card",
    },
    {
      ...commonRecord,
      stream: "trades",
      record_id: "private-trade",
      card_id: "private-card",
      event_type: "sale",
      amount: 10,
      currency: "USD",
      payment_method: null,
      tx_hash: "private-transaction",
    },
  ];
  for (const [index, member] of ["packs", "cards", "pulls", "trades"].entries()) {
    await writeFile(
      join(dataset, `collector_crypt_${member}.ndjson`),
      `${JSON.stringify(records[index])}\n`,
      "utf8",
    );
  }
  const archivePath = join(directory, "fixture.zip");
  const zipped = spawnSync("zip", ["-q", "-r", archivePath, "dataset"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(zipped.status, 0);
  const archiveSha256 = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  const dryRunArguments = common.map((value) =>
    value === "/does/not/matter.zip"
      ? archivePath
      : value === digest
        ? archiveSha256
        : value,
  );
  const environment = {
    ...process.env,
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
  };
  delete environment.PACKSCOUT_DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...dryRunArguments],
    { cwd: process.cwd(), encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.archiveSha256, archiveSha256);
  assert.equal(summary.records, 4);
  assert.equal(summary.chunks, 4);
  assert.equal(result.stdout.includes("private-pack"), false);
  assert.equal(result.stdout.includes("must-not-print"), false);
});
