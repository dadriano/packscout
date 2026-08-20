import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  isSafeServiceName,
  logFileNameForService,
  resolvePanelStateDirectory,
  resolveServiceLogDirectory,
  serviceLogFilePath,
  serviceNameFromLogFileName,
} from "./service-logs.ts";

const darwin = {
  env: {},
  platform: "darwin",
  homeDirectory: "/Users/operator",
};
const linux = {
  env: {},
  platform: "linux",
  homeDirectory: "/home/operator",
};

test("service names accept the documented safe character set", () => {
  assert.equal(isSafeServiceName("frontend"), true);
  assert.equal(isSafeServiceName("ops-panel"), true);
  assert.equal(isSafeServiceName("worker2"), true);
  assert.equal(isSafeServiceName("a"), true);
});

test("service names reject anything outside the safe character set", () => {
  for (const candidate of [
    "",
    "-frontend",
    "frontend-",
    "Frontend",
    "front end",
    "front_end",
    "front.end",
    "../etc/passwd",
    "front/end",
    "a".repeat(65),
    42,
    null,
    undefined,
  ]) {
    assert.equal(isSafeServiceName(candidate), false, String(candidate));
  }
});

test("log file names map to service names only when they match the convention", () => {
  assert.equal(serviceNameFromLogFileName("frontend.log"), "frontend");
  assert.equal(serviceNameFromLogFileName("ops-panel.log"), "ops-panel");
  assert.equal(serviceNameFromLogFileName("frontend.log.1"), null);
  assert.equal(serviceNameFromLogFileName("frontend.txt"), null);
  assert.equal(serviceNameFromLogFileName(".log"), null);
  assert.equal(serviceNameFromLogFileName("Frontend.log"), null);
  assert.equal(serviceNameFromLogFileName("../secrets.log"), null);
  assert.equal(serviceNameFromLogFileName("nested/frontend.log"), null);
  assert.equal(serviceNameFromLogFileName(7), null);
});

test("log file names are produced only for safe service names", () => {
  assert.equal(logFileNameForService("admin"), "admin.log");
  assert.throws(() => logFileNameForService("../admin"), /service name/);
});

test("the log directory follows the platform convention", () => {
  assert.equal(
    resolveServiceLogDirectory(darwin),
    "/Users/operator/Library/Logs/PackScout",
  );
  assert.equal(
    resolveServiceLogDirectory(linux),
    "/home/operator/.local/state/packscout/logs",
  );
  assert.equal(
    resolveServiceLogDirectory({
      ...linux,
      env: { XDG_STATE_HOME: "/var/state" },
    }),
    "/var/state/packscout/logs",
  );
});

test("PACKSCOUT_LOG_DIR overrides the platform default for every consumer", () => {
  assert.equal(
    resolveServiceLogDirectory({ ...darwin, env: { PACKSCOUT_LOG_DIR: "/tmp/logs" } }),
    "/tmp/logs",
  );
  assert.equal(
    serviceLogFilePath(
      { ...darwin, env: { PACKSCOUT_LOG_DIR: "/tmp/logs" } },
      "worker",
    ),
    path.join("/tmp/logs", "worker.log"),
  );
});

test("panel state lives outside the log directory", () => {
  assert.equal(
    resolvePanelStateDirectory(darwin),
    "/Users/operator/Library/Application Support/PackScout/ops-panel",
  );
  assert.equal(
    resolvePanelStateDirectory(linux),
    "/home/operator/.local/state/packscout/ops-panel",
  );
  assert.notEqual(
    resolvePanelStateDirectory(darwin),
    resolveServiceLogDirectory(darwin),
  );
});
