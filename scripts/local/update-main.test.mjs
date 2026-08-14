import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const updaterSource = readFileSync(new URL("./update-main.sh", import.meta.url), "utf8");
const temporaryRoots = [];

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeExecutable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "packscout-update-main-"));
  temporaryRoots.push(root);

  const seed = join(root, "seed");
  const remote = join(root, "remote.git");
  const checkout = join(root, "packscout");
  const outside = join(root, "outside");
  const fakeBin = join(root, "bin");
  const maintenanceTmp = join(root, "tmp");
  const npmLog = join(root, "npm.log");
  const restartLog = join(root, "restart.log");

  mkdirSync(seed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(maintenanceTmp, { recursive: true });
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "packscout-test@example.com");
  git(seed, "config", "user.name", "PackScout Test");

  writeFileSync(join(seed, "package.json"), '{"name":"packscout-update-test","private":true}\n');
  writeFileSync(join(seed, "package-lock.json"), '{"name":"packscout-update-test","lockfileVersion":3}\n');
  writeFileSync(join(seed, "version.txt"), "one\n");
  writeExecutable(join(seed, "scripts/local/update-main.sh"), updaterSource);
  writeExecutable(
    join(seed, "scripts/local/restart.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
lock="\${TMPDIR:?}/dev.packscout.maintenance.$(id -u).lock"
[[ -d "$lock" ]] || exit 90
owner_pid="$(sed -n 's/^pid=//p' "$lock/owner")"
owner_root="$(sed -n 's/^root=//p' "$lock/owner")"
[[ "\${PACKSCOUT_MAINTENANCE_LOCK_OWNER_PID:-}" = "$owner_pid" ]] || exit 91
[[ "$owner_pid" = "$PPID" ]] || exit 92
[[ "$owner_root" = "$PWD" ]] || exit 93
printf '%s|%s\\n' "$PWD" "$*" >> "\${PACKSCOUT_TEST_RESTART_LOG:?}"
`,
  );

  git(seed, "add", ".");
  git(seed, "commit", "-m", "initial");
  git(root, "init", "--bare", remote);
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", remote, checkout);
  git(checkout, "config", "user.email", "packscout-test@example.com");
  git(checkout, "config", "user.name", "PackScout Test");

  writeExecutable(
    join(fakeBin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\\n' "$PWD" "$*" >> "\${PACKSCOUT_TEST_NPM_LOG:?}"
`,
  );

  return {
    root,
    seed,
    remote,
    checkout,
    outside,
    fakeBin,
    maintenanceTmp,
    npmLog,
    restartLog,
  };
}

function publishRemoteChange(fixture, value = "two") {
  writeFileSync(join(fixture.seed, "version.txt"), `${value}\n`);
  git(fixture.seed, "add", "version.txt");
  git(fixture.seed, "commit", "-m", `publish ${value}`);
  git(fixture.seed, "push", "origin", "main");
}

function publishRemotePath(fixture, targetPath, { rename = false } = {}) {
  const absoluteTarget = join(fixture.seed, targetPath);
  mkdirSync(dirname(absoluteTarget), { recursive: true });
  if (rename) {
    git(fixture.seed, "mv", "version.txt", targetPath);
  } else {
    writeFileSync(absoluteTarget, "incoming\n");
    git(fixture.seed, "add", targetPath);
  }
  git(fixture.seed, "commit", "-m", `publish ${targetPath}`);
  git(fixture.seed, "push", "origin", "main");
}

function runUpdater(fixture, args = [], environment = {}, checkout = fixture.checkout) {
  return spawnSync("/bin/bash", [join(checkout, "scripts/local/update-main.sh"), ...args], {
    cwd: fixture.outside,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      TMPDIR: fixture.maintenanceTmp,
      PACKSCOUT_TEST_NPM_LOG: fixture.npmLog,
      PACKSCOUT_TEST_RESTART_LOG: fixture.restartLog,
      ...environment,
    },
  });
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertNoDeployCommands(fixture) {
  assert.equal(existsSync(fixture.npmLog), false, "npm ci must not run");
  assert.equal(existsSync(fixture.restartLog), false, "restart must not run");
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("update-main.sh", () => {
  it("fast-forwards from outside the repository, installs, and forwards only safe restart arguments", () => {
    const fixture = createFixture();
    publishRemoteChange(fixture);

    const result = runUpdater(fixture, [
      "--clean",
      "--frontend-mode",
      "mock-heat",
      "frontend",
      "worker",
    ]);

    assert.equal(result.status, 0, combinedOutput(result));
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), git(fixture.seed, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(fixture.checkout, "version.txt"), "utf8"), "two\n");

    const checkoutPath = realpathSync(fixture.checkout);
    assert.equal(readFileSync(fixture.npmLog, "utf8"), `${checkoutPath}|ci\n`);
    assert.equal(
      readFileSync(fixture.restartLog, "utf8"),
      `${checkoutPath}|--clean --frontend-mode mock-heat frontend worker\n`,
    );
  });

  it("refuses a non-main branch without switching it", () => {
    const fixture = createFixture();
    git(fixture.checkout, "switch", "-c", "feature");

    const result = runUpdater(fixture);

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /Current branch is 'feature'; switch to 'main'/);
    assert.equal(git(fixture.checkout, "branch", "--show-current"), "feature");
    assertNoDeployCommands(fixture);
  });

  it("refuses tracked and untracked workspace changes without exclusions", () => {
    for (const dirtyKind of ["tracked", "ordinary-untracked", "tasks", "output"]) {
      const fixture = createFixture();
      if (dirtyKind === "tracked") {
        appendFileSync(join(fixture.checkout, "version.txt"), "local\n");
      } else if (dirtyKind === "tasks") {
        mkdirSync(join(fixture.checkout, ".tasks"), { recursive: true });
        writeFileSync(join(fixture.checkout, ".tasks", "local-plan.md"), "do not delete\n");
      } else if (dirtyKind === "output") {
        mkdirSync(join(fixture.checkout, "output"), { recursive: true });
        writeFileSync(join(fixture.checkout, "output", "local.png"), "do not delete\n");
      } else {
        writeFileSync(join(fixture.checkout, "local-notes.txt"), "do not delete\n");
      }

      const result = runUpdater(fixture);

      assert.notEqual(result.status, 0, dirtyKind);
      assert.match(combinedOutput(result), /workspace must be completely clean/);
      if (dirtyKind !== "tracked") {
        const expectedPath = dirtyKind === "tasks"
          ? join(fixture.checkout, ".tasks", "local-plan.md")
          : dirtyKind === "output"
            ? join(fixture.checkout, "output", "local.png")
            : join(fixture.checkout, "local-notes.txt");
        assert.equal(readFileSync(expectedPath, "utf8"), "do not delete\n");
      }
      assertNoDeployCommands(fixture);
    }
  });

  it("preserves ignored paths that collide with incoming additions and rename targets", () => {
    const collisionCases = [
      { targetPath: ".env", ignorePattern: ".env", rename: false },
      {
        targetPath: "generated/cache/snapshot.json",
        ignorePattern: "generated/",
        rename: false,
      },
      { targetPath: "generated/renamed.txt", ignorePattern: "generated/", rename: true },
    ];

    for (const collisionCase of collisionCases) {
      const fixture = createFixture();
      const localHead = git(fixture.checkout, "rev-parse", "HEAD");
      const localTarget = join(fixture.checkout, collisionCase.targetPath);
      appendFileSync(
        join(fixture.checkout, ".git", "info", "exclude"),
        `${collisionCase.ignorePattern}\n`,
      );
      mkdirSync(dirname(localTarget), { recursive: true });
      writeFileSync(localTarget, "keep local\n");
      assert.equal(git(fixture.checkout, "status", "--porcelain", "--untracked-files=all"), "");
      publishRemotePath(fixture, collisionCase.targetPath, {
        rename: collisionCase.rename,
      });

      const result = runUpdater(fixture);

      assert.notEqual(result.status, 0, collisionCase.targetPath);
      assert.match(combinedOutput(result), /collides with an untracked or ignored local path/);
      assert.equal(readFileSync(localTarget, "utf8"), "keep local\n");
      assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
      assert.equal(
        git(fixture.checkout, "rev-parse", "origin/main"),
        git(fixture.seed, "rev-parse", "HEAD"),
        "fetch may update the remote-tracking ref before the collision is detected",
      );
      assertNoDeployCommands(fixture);
    }
  });

  it("refuses an incoming nested path blocked by an ignored parent file", () => {
    const fixture = createFixture();
    const localHead = git(fixture.checkout, "rev-parse", "HEAD");
    appendFileSync(join(fixture.checkout, ".git", "info", "exclude"), "generated\n");
    writeFileSync(join(fixture.checkout, "generated"), "keep parent file\n");
    publishRemotePath(fixture, "generated/cache/snapshot.json");

    const result = runUpdater(fixture);

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /blocked by untracked or ignored local parent 'generated'/);
    assert.equal(readFileSync(join(fixture.checkout, "generated"), "utf8"), "keep parent file\n");
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
    assertNoDeployCommands(fixture);
  });

  it("preserves an ignored child when an incoming change replaces its tracked directory with a file", () => {
    const fixture = createFixture();
    const seedTracked = join(fixture.seed, "foo", "tracked.txt");
    mkdirSync(dirname(seedTracked), { recursive: true });
    writeFileSync(seedTracked, "tracked\n");
    git(fixture.seed, "add", "foo/tracked.txt");
    git(fixture.seed, "commit", "-m", "publish tracked directory");
    git(fixture.seed, "push", "origin", "main");
    git(fixture.checkout, "pull", "--ff-only", "origin", "main");

    const localHead = git(fixture.checkout, "rev-parse", "HEAD");
    const ignoredChild = join(fixture.checkout, "foo", "ignored.txt");
    appendFileSync(join(fixture.checkout, ".git", "info", "exclude"), "foo/ignored.txt\n");
    writeFileSync(ignoredChild, "keep ignored child\n");
    assert.equal(git(fixture.checkout, "status", "--porcelain", "--untracked-files=all"), "");

    git(fixture.seed, "rm", "foo/tracked.txt");
    writeFileSync(join(fixture.seed, "foo"), "incoming file\n");
    git(fixture.seed, "add", "foo");
    git(fixture.seed, "commit", "-m", "replace directory with file");
    git(fixture.seed, "push", "origin", "main");

    const result = runUpdater(fixture);

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /changes 'foo' from Git object type 'tree' to 'blob'/);
    assert.equal(readFileSync(ignoredChild, "utf8"), "keep ignored child\n");
    assert.equal(readFileSync(join(fixture.checkout, "foo", "tracked.txt"), "utf8"), "tracked\n");
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
    assertNoDeployCommands(fixture);
  });

  it("refuses linked worktrees even when their branch is explicitly targeted", () => {
    const fixture = createFixture();
    const linked = join(fixture.root, "linked");
    git(fixture.checkout, "worktree", "add", "-b", "linked", linked);

    const result = runUpdater(
      fixture,
      [],
      { PACKSCOUT_UPDATE_BRANCH: "linked" },
      linked,
    );

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /primary PackScout checkout/);
    assertNoDeployCommands(fixture);
  });

  it("rejects a local-ahead main branch", () => {
    const fixture = createFixture();
    appendFileSync(join(fixture.checkout, "version.txt"), "local ahead\n");
    git(fixture.checkout, "add", "version.txt");
    git(fixture.checkout, "commit", "-m", "local ahead");
    const localHead = git(fixture.checkout, "rev-parse", "HEAD");

    const result = runUpdater(fixture);

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /is ahead of 'origin\/main'/);
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
    assertNoDeployCommands(fixture);
  });

  it("rejects a diverged main branch", () => {
    const fixture = createFixture();
    appendFileSync(join(fixture.checkout, "version.txt"), "local divergence\n");
    git(fixture.checkout, "add", "version.txt");
    git(fixture.checkout, "commit", "-m", "local divergence");
    const localHead = git(fixture.checkout, "rev-parse", "HEAD");
    publishRemoteChange(fixture, "remote divergence");

    const result = runUpdater(fixture);

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /has diverged from 'origin\/main'/);
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
    assertNoDeployCommands(fixture);
  });

  it("prints a dry run without fetching, merging, installing, or restarting", () => {
    const fixture = createFixture();
    const localHead = git(fixture.checkout, "rev-parse", "HEAD");
    const trackingHead = git(fixture.checkout, "rev-parse", "origin/main");
    publishRemoteChange(fixture);

    const result = runUpdater(fixture, ["--dry-run", "--clean", "admin"]);

    assert.equal(result.status, 0, combinedOutput(result));
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
    assert.equal(git(fixture.checkout, "rev-parse", "origin/main"), trackingHead);
    assert.match(result.stdout, /git -C .* fetch origin main/);
    assert.match(result.stdout, /merge --ff-only refs\/remotes\/origin\/main/);
    assert.match(result.stdout, /npm ci/);
    assert.match(result.stdout, /restart\.sh --clean admin/);
    assertNoDeployCommands(fixture);
  });

  it("supports explicit remote and branch overrides", () => {
    const fixture = createFixture();
    git(fixture.seed, "switch", "-c", "release");
    git(fixture.seed, "push", "-u", "origin", "release");
    git(fixture.checkout, "fetch", "origin", "release");
    git(fixture.checkout, "switch", "-c", "release", "--track", "origin/release");
    git(fixture.checkout, "remote", "rename", "origin", "upstream");
    writeFileSync(join(fixture.seed, "version.txt"), "release two\n");
    git(fixture.seed, "add", "version.txt");
    git(fixture.seed, "commit", "-m", "publish release two");
    git(fixture.seed, "push", "origin", "release");

    const result = runUpdater(fixture, ["frontend"], {
      PACKSCOUT_UPDATE_REMOTE: "upstream",
      PACKSCOUT_UPDATE_BRANCH: "release",
    });

    assert.equal(result.status, 0, combinedOutput(result));
    assert.equal(readFileSync(join(fixture.checkout, "version.txt"), "utf8"), "release two\n");
  });

  it("rejects a leading-dash branch before fetch can mutate refs", () => {
    const fixture = createFixture();
    const localHead = git(fixture.checkout, "rev-parse", "HEAD");
    const trackingHead = git(fixture.checkout, "rev-parse", "origin/main");
    publishRemoteChange(fixture);

    const result = runUpdater(fixture, [], { PACKSCOUT_UPDATE_BRANCH: "-p" });

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /Invalid update branch '-p'/);
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
    assert.equal(git(fixture.checkout, "rev-parse", "origin/main"), trackingHead);
    assertNoDeployCommands(fixture);
  });

  it("uses the shared maintenance lock and leaves a contending operation untouched", () => {
    const fixture = createFixture();
    const lockDirectory = join(
      fixture.maintenanceTmp,
      `dev.packscout.maintenance.${process.getuid()}.lock`,
    );
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, "owner"), "pid=24680\nroot=/another/run\n");
    const trackingHead = git(fixture.checkout, "rev-parse", "origin/main");
    publishRemoteChange(fixture);

    const result = runUpdater(fixture);

    assert.notEqual(result.status, 0);
    assert.match(combinedOutput(result), /Another PackScout maintenance operation is already running/);
    assert.equal(git(fixture.checkout, "rev-parse", "origin/main"), trackingHead);
    assert.equal(
      readFileSync(join(lockDirectory, "owner"), "utf8"),
      "pid=24680\nroot=/another/run\n",
    );
    assertNoDeployCommands(fixture);
  });

  it("releases its update lock after the transaction completes", () => {
    const fixture = createFixture();
    publishRemoteChange(fixture);

    const result = runUpdater(fixture);

    assert.equal(result.status, 0, combinedOutput(result));
    assert.equal(
      existsSync(
        join(
          fixture.maintenanceTmp,
          `dev.packscout.maintenance.${process.getuid()}.lock`,
        ),
      ),
      false,
    );
  });

  it("releases its update lock when a transaction step fails", () => {
    const fixture = createFixture();
    publishRemoteChange(fixture);
    writeExecutable(
      join(fixture.fakeBin, "npm"),
      `#!/usr/bin/env bash
exit 23
`,
    );

    const result = runUpdater(fixture);

    assert.equal(result.status, 23, combinedOutput(result));
    assert.equal(
      existsSync(
        join(
          fixture.maintenanceTmp,
          `dev.packscout.maintenance.${process.getuid()}.lock`,
        ),
      ),
      false,
    );
    assert.equal(existsSync(fixture.restartLog), false, "restart must not run after npm fails");
  });

  it("prints a complete side-effect-free help guide", () => {
    const fixture = createFixture();
    publishRemoteChange(fixture);
    const localHead = git(fixture.checkout, "rev-parse", "HEAD");
    const trackingHead = git(fixture.checkout, "rev-parse", "origin/main");

    const invalidTargetEnvironment = {
      PACKSCOUT_UPDATE_REMOTE: "-invalid",
      PACKSCOUT_UPDATE_BRANCH: "-invalid",
    };
    const longHelp = runUpdater(
      fixture,
      ["--help"],
      invalidTargetEnvironment,
    );
    const shortHelp = runUpdater(
      fixture,
      ["-h"],
      invalidTargetEnvironment,
    );

    assert.equal(longHelp.status, 0, combinedOutput(longHelp));
    assert.equal(longHelp.stderr, "");
    assert.equal(shortHelp.status, 0, combinedOutput(shortHelp));
    assert.equal(shortHelp.stdout, longHelp.stdout);
    for (const section of [
      "Usage:",
      "Update options:",
      "Services:",
      "Options forwarded to restart.sh:",
      "Update sequence:",
      "Safety:",
      "Explicit environment overrides:",
      "Examples:",
      "Exit status:",
    ]) {
      assert.match(longHelp.stdout, new RegExp(section.replace(".", "\\.")));
    }
    assert.match(longHelp.stdout, /workspace:update:main:local/);
    assert.match(longHelp.stdout, /fast-forward-only/);
    assert.match(longHelp.stdout, /npm ci/);
    assert.match(longHelp.stdout, /--frontend-mode=<mode>/);
    assert.match(longHelp.stdout, /without fetching or changing[\s\S]*workspace files/);
    assert.match(longHelp.stdout, /no service names[\s\S]*frontend,[\s\S]*admin,[\s\S]*worker/i);
    assert.equal(git(fixture.checkout, "rev-parse", "HEAD"), localHead);
    assert.equal(git(fixture.checkout, "rev-parse", "origin/main"), trackingHead);
    assertNoDeployCommands(fixture);
    assert.equal(
      existsSync(
        join(
          fixture.maintenanceTmp,
          `dev.packscout.maintenance.${process.getuid()}.lock`,
        ),
      ),
      false,
    );
  });

  it("explicitly rejects force or unsafe restart arguments", () => {
    const fixture = createFixture();

    for (const args of [["--force"], ["--frontend-mode", "production"], ["database"]]) {
      const result = runUpdater(fixture, args);
      assert.notEqual(result.status, 0, args.join(" "));
    }
    assertNoDeployCommands(fixture);
  });

  it("contains no destructive Git workspace operation", () => {
    assert.doesNotMatch(updaterSource, /git(?:\s+-C\s+"\$ROOT")?\s+(?:checkout|reset|clean)\b/);
    assert.doesNotMatch(updaterSource, /rm\s+-[A-Za-z]*r[A-Za-z]*f|rm\s+-[A-Za-z]*f[A-Za-z]*r/);
    assert.match(updaterSource, /git -C "\$ROOT" merge --ff-only "\$REMOTE_REF"/);
    assert.match(updaterSource, /mkdir "\$UPDATE_LOCK_DIR"/);
  });
});
