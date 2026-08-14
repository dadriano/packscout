import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceScript = fileURLToPath(new URL("./restart.sh", import.meta.url));
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function executable(filePath, source) {
  writeFileSync(filePath, source);
  chmodSync(filePath, 0o755);
}

function git(root, ...args) {
  const outcome = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(outcome.status, 0, outcome.stderr);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "PackScout restart test "));
  temporaryRoots.push(root);
  const localScripts = path.join(root, "scripts", "local");
  const fakeBin = path.join(root, "fake-bin");
  const fakeHome = path.join(root, "home");
  const fakeState = path.join(root, "launchctl-state");
  const fakeTmp = path.join(root, "tmp");
  mkdirSync(localScripts, { recursive: true });
  mkdirSync(path.join(root, "apps", "frontend"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeState, { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  cpSync(sourceScript, path.join(localScripts, "restart.sh"));
  chmodSync(path.join(localScripts, "restart.sh"), 0o755);
  writeFileSync(path.join(root, ".env"), "PACKSCOUT_TEST_SECRET=do-not-copy\n");
  writeFileSync(path.join(root, ".env.local"), "CONVEX_DEPLOYMENT=local:test\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@packscout.local");
  git(root, "config", "user.name", "PackScout Test");

  const commandLog = path.join(root, "commands.log");
  executable(
    path.join(fakeBin, "uname"),
    "#!/bin/sh\necho Darwin\n",
  );
  executable(
    path.join(fakeBin, "npm"),
    "#!/bin/sh\nexit 0\n",
  );
  executable(
    path.join(fakeBin, "launchctl"),
    `#!/bin/sh
printf 'launchctl %s\\n' "$*" >> "$PACKSCOUT_TEST_COMMAND_LOG"
target="\${2:-}"
label="\${target##*/}"
state="$PACKSCOUT_TEST_LAUNCHCTL_STATE/$label"
case "$1" in
  bootout)
    if [ ! -f "$state" ]; then exit 3; fi
    if [ "\${PACKSCOUT_FAKE_BOOTOUT_FAILURE:-}" = "$label" ]; then exit 5; fi
    if [ "\${PACKSCOUT_FAKE_BOOTOUT_STAYS_LOADED:-}" = "$label" ]; then exit 0; fi
    rm -f "$state"
    exit 0
    ;;
  bootstrap)
    if [ "\${PACKSCOUT_FAKE_BOOTSTRAP_FAILURE:-}" != "" ]; then
      case "$*" in *"$PACKSCOUT_FAKE_BOOTSTRAP_FAILURE"*) exit 1 ;; esac
    fi
    plist="\${3:-}"
    label="\${plist##*/}"
    label="\${label%.plist}"
    : > "$PACKSCOUT_TEST_LAUNCHCTL_STATE/$label"
    exit 0
    ;;
  print)
    [ -f "$state" ] || exit 3
    if [ "\${PACKSCOUT_FAKE_FOREIGN_LOADED_SERVICE:-}" = "$label" ]; then
      echo 'working directory = /foreign/packscout'
    else
      echo "working directory = $PACKSCOUT_TEST_ROOT"
    fi
    echo 'state = running'
    echo 'pid = 9876'
    ;;
  *) exit 0 ;;
esac
`,
  );
  executable(
    path.join(fakeBin, "curl"),
    `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$PACKSCOUT_TEST_COMMAND_LOG"
if [ "\${PACKSCOUT_FAKE_HEALTH:-ok}" = "fail" ]; then exit 22; fi
case "$*" in
  *5100*)
    if [ "\${PACKSCOUT_FAKE_HEALTH:-ok}" = "wrong" ]; then
      printf '%s' '{"ok":true,"service":"wrong-service","framework":"next"}'
    else
      printf '%s' '{"ok":true,"service":"packscout-frontend","framework":"next"}'
    fi
    ;;
  *5101*) printf '%s' '{"ok":true,"service":"packscout-admin"}' ;;
  *) exit 22 ;;
esac
`,
  );
  executable(
    path.join(fakeBin, "lsof"),
    `#!/bin/sh
printf 'lsof %s\\n' "$*" >> "$PACKSCOUT_TEST_COMMAND_LOG"
if [ "\${PACKSCOUT_FAKE_OCCUPIED_PORT:-}" != "" ]; then
  case "$*" in *":$PACKSCOUT_FAKE_OCCUPIED_PORT"*) echo 4321; exit 0 ;; esac
fi
service=""
case "$*" in
  *:5100*) service=frontend ;;
  *:5101*|*:5102*) service=admin ;;
esac
if [ "$service" != "" ] && [ -f "$PACKSCOUT_TEST_LAUNCHCTL_STATE/dev.packscout.$service" ]; then
  if [ "\${PACKSCOUT_FAKE_POST_HEALTH_FOREIGN_PORT:-}" != "" ]; then
    case "$*" in *":$PACKSCOUT_FAKE_POST_HEALTH_FOREIGN_PORT"*) echo 4321; exit 0 ;; esac
  fi
  echo 9876
  exit 0
fi
exit 1
`,
  );
  executable(
    path.join(fakeBin, "ps"),
    `#!/bin/sh
if [ "\${2:-}" = "4321" ] && [ "\${PACKSCOUT_FAKE_PARENT_PID:-}" != "" ]; then
  echo "$PACKSCOUT_FAKE_PARENT_PID"
  exit 0
fi
exit 1
`,
  );
  executable(
    path.join(fakeBin, "plutil"),
    `#!/bin/sh
if [ "\${1:-}" = "-lint" ]; then exit 0; fi
if [ "\${1:-}" = "-extract" ] && [ "\${2:-}" = "WorkingDirectory" ]; then
  awk '/<key>WorkingDirectory<\\/key>/{getline; gsub(/.*<string>|<\\/string>.*/, ""); print; exit}' "\${6:-}"
  exit 0
fi
exit 1
`,
  );

  return {
    root,
    script: path.join(localScripts, "restart.sh"),
    home: fakeHome,
    fakeBin,
    state: fakeState,
    temporaryDirectory: fakeTmp,
    commandLog,
    env: {
      ...process.env,
      HOME: fakeHome,
      TMPDIR: fakeTmp,
      PATH: `${fakeBin}:${process.env.PATH}`,
      PACKSCOUT_TEST_ROOT: realpathSync(root),
      PACKSCOUT_TEST_LAUNCHCTL_STATE: fakeState,
      PACKSCOUT_TEST_COMMAND_LOG: commandLog,
      PACKSCOUT_RESTART_MAX_ATTEMPTS: "3",
      PACKSCOUT_RESTART_POLL_SECONDS: "0",
      PACKSCOUT_RESTART_WORKER_STABILITY_POLLS: "2",
    },
  };
}

function markLoaded(fixture, service) {
  writeExistingPlist(fixture, service, realpathSync(fixture.root));
  writeFileSync(path.join(fixture.state, `dev.packscout.${service}`), "loaded\n");
}

function writeExistingPlist(fixture, service, workingDirectory) {
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, `dev.packscout.${service}.plist`),
    `<plist><dict><key>WorkingDirectory</key><string>${workingDirectory}</string></dict></plist>\n`,
  );
}

function runFixture(fixture, args = [], environment = {}) {
  return spawnSync("bash", [fixture.script, ...args], {
    cwd: tmpdir(),
    env: { ...fixture.env, ...environment },
    encoding: "utf8",
  });
}

function commandLog(fixture) {
  return existsSync(fixture.commandLog)
    ? readFileSync(fixture.commandLog, "utf8")
    : "";
}

describe("scripts/local/restart.sh", () => {
  test("prints a complete side-effect-free help guide", () => {
    const fixture = createFixture();
    rmSync(path.join(fixture.root, ".env"));
    rmSync(path.join(fixture.root, ".env.local"));

    const invalidReadinessEnvironment = {
      PACKSCOUT_RESTART_MAX_ATTEMPTS: "invalid",
      PACKSCOUT_RESTART_POLL_SECONDS: "invalid",
      PACKSCOUT_RESTART_WORKER_STABILITY_POLLS: "invalid",
    };
    const longHelp = runFixture(
      fixture,
      ["--help"],
      invalidReadinessEnvironment,
    );
    const shortHelp = runFixture(
      fixture,
      ["-h"],
      invalidReadinessEnvironment,
    );

    assert.equal(longHelp.status, 0, longHelp.stderr);
    assert.equal(longHelp.stderr, "");
    assert.equal(shortHelp.status, 0, shortHelp.stderr);
    assert.equal(shortHelp.stdout, longHelp.stdout);
    for (const section of [
      "Usage:",
      "Services:",
      "Options:",
      "Frontend modes:",
      "Prerequisites:",
      "Safety and diagnostics:",
      "Readiness tuning:",
      "Examples:",
      "Exit status:",
    ]) {
      assert.match(longHelp.stdout, new RegExp(section));
    }
    assert.match(longHelp.stdout, /services:restart:local/);
    assert.match(longHelp.stdout, /standard[\s\S]*mock[\s\S]*mock-heat/);
    assert.match(longHelp.stdout, /5100[\s\S]*5101[\s\S]*5102/);
    assert.match(longHelp.stdout, /Library\/Logs\/PackScout/);
    assert.match(longHelp.stdout, /no service names[\s\S]*frontend,[\s\S]*admin,[\s\S]*worker/i);
    assert.match(
      longHelp.stdout,
      /If stopping a later service[\s\S]*attempts to restore services stopped earlier/,
    );
    assert.match(
      longHelp.stdout,
      /startup\/readiness failure[\s\S]*without promising full\s+rollback/i,
    );
    assert.equal(commandLog(fixture), "");
    assert.equal(existsSync(path.join(fixture.home, "Library", "LaunchAgents")), false);
    assert.equal(
      existsSync(
        path.join(
          fixture.temporaryDirectory,
          `dev.packscout.maintenance.${process.getuid()}.lock`,
        ),
      ),
      false,
    );
  });

  test("generates secret-free launchd jobs and verifies every default service", () => {
    const fixture = createFixture();
    const outcome = runFixture(fixture);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /ready frontend/);
    assert.match(outcome.stdout, /ready admin/);
    assert.match(outcome.stdout, /running worker \(process liveness only/);

    const agents = path.join(fixture.home, "Library", "LaunchAgents");
    const frontend = readFileSync(
      path.join(agents, "dev.packscout.frontend.plist"),
      "utf8",
    );
    const admin = readFileSync(
      path.join(agents, "dev.packscout.admin.plist"),
      "utf8",
    );
    const worker = readFileSync(
      path.join(agents, "dev.packscout.worker.plist"),
      "utf8",
    );
    assert.match(frontend, /<string>dev:frontend<\/string>/);
    assert.match(frontend, /<key>PACKSCOUT_FRONTEND_HOST<\/key>\s*<string>127\.0\.0\.1<\/string>/);
    const discoveredNode = spawnSync("sh", ["-c", "command -v node"], {
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(discoveredNode.status, 0, discoveredNode.stderr);
    const expectedNodeDirectory = path.dirname(discoveredNode.stdout.trim());
    assert.match(
      frontend,
      new RegExp(`${fixture.fakeBin.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${expectedNodeDirectory.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    assert.match(admin, /<string>dev:admin<\/string>/);
    assert.match(admin, /<key>PACKSCOUT_ADMIN_HMR_PORT<\/key>\s*<string>5102<\/string>/);
    assert.match(worker, /<string>start:worker:local<\/string>/);
    assert.match(frontend, new RegExp(realpathSync(fixture.root).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (const plist of [frontend, admin, worker]) {
      assert.doesNotMatch(plist, /do-not-copy|DATABASE_URL|SESSION_HASHING_SECRET|CONVEX_DEPLOY_KEY/);
      assert.doesNotMatch(plist, /dev\.lains|<string>(?:3000|3001|4000)<\/string>|prisma|<string>[^<]*mcp[^<]*<\/string>/i);
    }

    const log = commandLog(fixture);
    assert.match(log, /bootstrap gui\/\d+ .*dev\.packscout\.frontend\.plist/);
    assert.match(log, /bootstrap gui\/\d+ .*dev\.packscout\.admin\.plist/);
    assert.match(log, /bootstrap gui\/\d+ .*dev\.packscout\.worker\.plist/);
    assert.match(log, /curl .*http:\/\/127\.0\.0\.1:5100\/api\/health/);
    assert.match(log, /curl .*http:\/\/127\.0\.0\.1:5101\/api\/health/);
  });

  test("uses explicit mock-heat mode and cleans only frontend caches", () => {
    const fixture = createFixture();
    const frontendRoot = path.join(fixture.root, "apps", "frontend");
    const taskSentinel = path.join(fixture.root, ".tasks", "keep.md");
    const outputSentinel = path.join(fixture.root, "output", "keep.png");
    mkdirSync(path.join(frontendRoot, ".next-dev"), { recursive: true });
    mkdirSync(path.join(frontendRoot, ".next-build"), { recursive: true });
    mkdirSync(path.dirname(taskSentinel), { recursive: true });
    mkdirSync(path.dirname(outputSentinel), { recursive: true });
    writeFileSync(taskSentinel, "keep");
    writeFileSync(outputSentinel, "keep");

    const outcome = runFixture(fixture, [
      "--clean",
      "--frontend-mode",
      "mock-heat",
      "frontend",
    ]);
    assert.equal(outcome.status, 0, outcome.stderr);
    const plist = readFileSync(
      path.join(
        fixture.home,
        "Library",
        "LaunchAgents",
        "dev.packscout.frontend.plist",
      ),
      "utf8",
    );
    assert.match(plist, /<string>dev:frontend:mock-heat:local<\/string>/);
    assert.equal(existsSync(path.join(frontendRoot, ".next-dev")), false);
    assert.equal(existsSync(path.join(frontendRoot, ".next-build")), false);
    assert.equal(readFileSync(taskSentinel, "utf8"), "keep");
    assert.equal(readFileSync(outputSentinel, "utf8"), "keep");
    assert.doesNotMatch(commandLog(fixture), /dev\.packscout\.(admin|worker)/);
  });

  test("fails closed on an occupied port without killing its owner", () => {
    const fixture = createFixture();
    const outcome = runFixture(
      fixture,
      ["frontend"],
      { PACKSCOUT_FAKE_OCCUPIED_PORT: "5100" },
    );
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /port 5100 is owned by a foreign process/);
    assert.doesNotMatch(commandLog(fixture), /bootstrap/);
    assert.doesNotMatch(readFileSync(fixture.script, "utf8"), /kill\s+.*\$|killall|pkill/);
  });

  test("requires the exact health contract and unloads a failed job", () => {
    const fixture = createFixture();
    const outcome = runFixture(
      fixture,
      ["frontend"],
      { PACKSCOUT_FAKE_HEALTH: "wrong" },
    );
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /did not return its expected health contract/);
    const log = commandLog(fixture);
    assert.equal((log.match(/curl /g) ?? []).length, 3);
    assert.match(log, /bootout gui\/\d+\/dev\.packscout\.frontend/);
  });

  test("propagates launchd bootstrap failure without claiming success", () => {
    const fixture = createFixture();
    const outcome = runFixture(
      fixture,
      ["frontend"],
      { PACKSCOUT_FAKE_BOOTSTRAP_FAILURE: "frontend.plist" },
    );
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /launchd failed to bootstrap frontend/);
    assert.doesNotMatch(outcome.stdout, /restarted successfully/);
    assert.doesNotMatch(commandLog(fixture), /curl /);
  });

  test("rejects unknown inputs before touching launchd", () => {
    const fixture = createFixture();
    const unknownService = runFixture(fixture, ["database"]);
    assert.notEqual(unknownService.status, 0);
    assert.match(unknownService.stderr, /Unknown service: database/);
    const unknownMode = runFixture(fixture, [
      "--frontend-mode",
      "production",
      "frontend",
    ]);
    assert.notEqual(unknownMode.status, 0);
    assert.match(unknownMode.stderr, /Unknown frontend mode: production/);
    assert.equal(commandLog(fixture), "");
  });

  test("preflights all selected ports before stopping any service", () => {
    const fixture = createFixture();
    markLoaded(fixture, "frontend");
    markLoaded(fixture, "worker");
    const outcome = runFixture(fixture, [], {
      PACKSCOUT_FAKE_OCCUPIED_PORT: "5101",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /admin cannot restart because port 5101 is owned by a foreign process/);
    assert.doesNotMatch(commandLog(fixture), /launchctl bootout/);
    assert.doesNotMatch(commandLog(fixture), /launchctl bootstrap/);
  });

  test("refuses an existing plist owned by another checkout", () => {
    const fixture = createFixture();
    writeExistingPlist(fixture, "frontend", "/foreign/packscout");
    const outcome = runFixture(fixture, ["frontend"]);
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /Existing frontend plist belongs to a different checkout/);
    assert.doesNotMatch(commandLog(fixture), /launchctl (?:bootout|bootstrap)/);
  });

  test("fails closed when launchd cannot boot out a loaded worker", () => {
    const fixture = createFixture();
    markLoaded(fixture, "worker");
    const outcome = runFixture(fixture, ["worker"], {
      PACKSCOUT_FAKE_BOOTOUT_FAILURE: "dev.packscout.worker",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /failed to boot out loaded worker job/);
    assert.match(commandLog(fixture), /launchctl bootout .*dev\.packscout\.worker/);
    assert.doesNotMatch(commandLog(fixture), /launchctl bootstrap/);
  });

  test("serializes restarts with an atomic per-user lock", () => {
    const fixture = createFixture();
    const lock = path.join(
      fixture.temporaryDirectory,
      `dev.packscout.maintenance.${process.getuid()}.lock`,
    );
    mkdirSync(lock);
    writeFileSync(path.join(lock, "owner"), "pid=24680\nroot=/another/run\n");
    const outcome = runFixture(fixture, ["frontend"]);
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /maintenance operation is already in progress.*pid: 24680/);
    assert.equal(readFileSync(path.join(lock, "owner"), "utf8"), "pid=24680\nroot=/another/run\n");
    assert.equal(commandLog(fixture), "");
  });

  test("restores an earlier service when a later loaded job cannot stop", () => {
    const fixture = createFixture();
    markLoaded(fixture, "frontend");
    markLoaded(fixture, "worker");
    const outcome = runFixture(fixture, ["frontend", "worker"], {
      PACKSCOUT_FAKE_BOOTOUT_FAILURE: "dev.packscout.worker",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /Previously running services were restored/);
    assert.equal(existsSync(path.join(fixture.state, "dev.packscout.frontend")), true);
    assert.equal(existsSync(path.join(fixture.state, "dev.packscout.worker")), true);
    const log = commandLog(fixture);
    assert.match(log, /bootout .*dev\.packscout\.frontend/);
    assert.match(log, /bootout .*dev\.packscout\.worker/);
    assert.match(log, /bootstrap .*dev\.packscout\.frontend\.plist/);
  });

  test("reports rollback incomplete when a reloaded service is not actually ready", () => {
    const fixture = createFixture();
    markLoaded(fixture, "frontend");
    markLoaded(fixture, "worker");
    const outcome = runFixture(fixture, ["frontend", "worker"], {
      PACKSCOUT_FAKE_BOOTOUT_FAILURE: "dev.packscout.worker",
      PACKSCOUT_FAKE_HEALTH: "fail",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(
      outcome.stderr,
      /rollback loaded frontend but could not verify its health and listener ownership/,
    );
    assert.match(outcome.stderr, /Rollback was incomplete/);
    assert.doesNotMatch(outcome.stderr, /Previously running services were restored/);
  });

  test("verifies readiness when bootout succeeds but the job never unloads", () => {
    const fixture = createFixture();
    markLoaded(fixture, "frontend");
    const outcome = runFixture(fixture, ["frontend"], {
      PACKSCOUT_FAKE_BOOTOUT_STAYS_LOADED: "dev.packscout.frontend",
      PACKSCOUT_FAKE_HEALTH: "fail",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /remained loaded after bootout/);
    assert.match(
      outcome.stderr,
      /rollback loaded frontend but could not verify its health and listener ownership/,
    );
    assert.match(outcome.stderr, /Rollback was incomplete/);
    assert.doesNotMatch(outcome.stderr, /Previously running services were restored/);
  });

  test("restores a stopped service when its owned port does not release", () => {
    const fixture = createFixture();
    markLoaded(fixture, "frontend");
    const outcome = runFixture(fixture, ["frontend"], {
      PACKSCOUT_FAKE_OCCUPIED_PORT: "5100",
      PACKSCOUT_FAKE_PARENT_PID: "9876",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /port 5100 remains occupied after its launchd job stopped/);
    assert.match(outcome.stderr, /Previously running services were restored/);
    assert.equal(existsSync(path.join(fixture.state, "dev.packscout.frontend")), true);
    assert.match(commandLog(fixture), /bootstrap .*dev\.packscout\.frontend\.plist/);
  });

  test("rejects health served by a listener outside the current launchd job", () => {
    const fixture = createFixture();
    const outcome = runFixture(fixture, ["frontend"], {
      PACKSCOUT_FAKE_POST_HEALTH_FOREIGN_PORT: "5100",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /health on port 5100 was served by a process outside its current launchd job/);
    assert.equal(existsSync(path.join(fixture.state, "dev.packscout.frontend")), false);
  });

  test("rejects an admin HMR listener outside the current launchd job", () => {
    const fixture = createFixture();
    const outcome = runFixture(fixture, ["admin"], {
      PACKSCOUT_FAKE_POST_HEALTH_FOREIGN_PORT: "5102",
    });
    assert.notEqual(outcome.status, 0);
    assert.match(
      outcome.stderr,
      /admin health on port 5102 was served by a process outside its current launchd job/,
    );
    assert.equal(existsSync(path.join(fixture.state, "dev.packscout.admin")), false);
  });

  test("captures worker launchd state once per stability poll", () => {
    const fixture = createFixture();
    const outcome = runFixture(fixture, ["worker"]);
    assert.equal(outcome.status, 0, outcome.stderr);
    const prints = commandLog(fixture).match(/launchctl print .*dev\.packscout\.worker/g) ?? [];
    assert.equal(prints.length, 4);
  });

  test("honors a validated maintenance lock held by its direct parent", () => {
    const fixture = createFixture();
    const lock = path.join(
      fixture.temporaryDirectory,
      `dev.packscout.maintenance.${process.getuid()}.lock`,
    );
    mkdirSync(lock);
    const owner = `pid=${process.pid}\nroot=${realpathSync(fixture.root)}\n`;
    writeFileSync(path.join(lock, "owner"), owner);
    const outcome = runFixture(fixture, ["frontend"], {
      PACKSCOUT_MAINTENANCE_LOCK_OWNER_PID: String(process.pid),
    });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(readFileSync(path.join(lock, "owner"), "utf8"), owner);
  });
});
