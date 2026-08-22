import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultStudioPort,
  describeStartupFailure,
  OPS_PANEL_DEFAULT_HMR_PORT,
  OPS_PANEL_DEFAULT_PORT,
  panelOrigin,
  readLoopbackBindHost,
  readOpsPanelConfiguration,
  readPollIntervalMs,
  readReservedPort,
} from "./runtime-config.ts";

test("the default port sits inside the reserved local range and avoids existing services", () => {
  assert.equal(OPS_PANEL_DEFAULT_PORT, 5110);
  assert.equal(OPS_PANEL_DEFAULT_HMR_PORT, 5111);
  for (const taken of [5100, 5101, 5102]) {
    assert.notEqual(OPS_PANEL_DEFAULT_PORT, taken);
    assert.notEqual(OPS_PANEL_DEFAULT_HMR_PORT, taken);
  }
});

test("ports outside the reserved range are refused", () => {
  assert.equal(readReservedPort(undefined, 5110, "PORT"), 5110);
  assert.equal(readReservedPort("5150", 5110, "PORT"), 5150);
  assert.throws(() => readReservedPort("3000", 5110, "PORT"), /5100 and 5199/);
  assert.throws(() => readReservedPort("5099", 5110, "PORT"), /5100 and 5199/);
  assert.throws(() => readReservedPort("not-a-port", 5110, "PORT"), /5100 and 5199/);
});

test("the bind host must be loopback", () => {
  assert.equal(readLoopbackBindHost(undefined, "HOST"), "127.0.0.1");
  assert.equal(readLoopbackBindHost("::1", "HOST"), "::1");
  assert.equal(readLoopbackBindHost("localhost", "HOST"), "localhost");
  assert.throws(() => readLoopbackBindHost("0.0.0.0", "HOST"), /loopback/);
  assert.throws(() => readLoopbackBindHost("192.168.1.20", "HOST"), /loopback/);
});

test("the discovery poll interval stays bounded", () => {
  assert.equal(readPollIntervalMs(undefined, "POLL"), 1_000);
  assert.equal(readPollIntervalMs("500", "POLL"), 500);
  assert.throws(() => readPollIntervalMs("10", "POLL"), /between 250 and 10000/);
  assert.throws(() => readPollIntervalMs("60000", "POLL"), /between 250 and 10000/);
});

test("configuration reads defaults and overrides together", () => {
  assert.deepEqual(readOpsPanelConfiguration({}), {
    host: "127.0.0.1",
    port: 5110,
    hmrPort: 5111,
    studioPort: 5112,
    pollIntervalMs: 1_000,
    tailIntervalMs: 200,
    databaseRefreshMs: 5_000,
  });
  assert.deepEqual(
    readOpsPanelConfiguration({
      PACKSCOUT_OPS_PANEL_PORT: "5120",
      PACKSCOUT_OPS_PANEL_POLL_MS: "2000",
      PACKSCOUT_OPS_PANEL_TAIL_MS: "500",
      PACKSCOUT_OPS_PANEL_DATABASE_REFRESH_MS: "10000",
    }),
    {
      host: "127.0.0.1",
      port: 5120,
      hmrPort: 5121,
      studioPort: 5122,
      pollIntervalMs: 2_000,
      tailIntervalMs: 500,
      databaseRefreshMs: 10_000,
    },
  );
});

test("the row browser's port stays inside the reserved range", () => {
  assert.equal(defaultStudioPort(5110), 5112);
  assert.equal(defaultStudioPort(5198), 5100);
  assert.equal(defaultStudioPort(5199), 5101);
  assert.equal(
    readOpsPanelConfiguration({ PACKSCOUT_OPS_PANEL_STUDIO_PORT: "5150" }).studioPort,
    5150,
  );
  assert.throws(
    () => readOpsPanelConfiguration({ PACKSCOUT_OPS_PANEL_STUDIO_PORT: "5555" }),
    /between 5100 and 5199/,
  );
});

test("the database refresh interval is bounded on both sides", () => {
  assert.throws(
    () =>
      readOpsPanelConfiguration({ PACKSCOUT_OPS_PANEL_DATABASE_REFRESH_MS: "10" }),
    /between 1000 and 60000 milliseconds/,
  );
  assert.throws(
    () =>
      readOpsPanelConfiguration({ PACKSCOUT_OPS_PANEL_DATABASE_REFRESH_MS: "120000" }),
    /between 1000 and 60000 milliseconds/,
  );
});

test("the tail interval is bounded on both sides", () => {
  assert.equal(
    readOpsPanelConfiguration({ PACKSCOUT_OPS_PANEL_TAIL_MS: "50" })
      .tailIntervalMs,
    50,
  );
  assert.throws(
    () => readOpsPanelConfiguration({ PACKSCOUT_OPS_PANEL_TAIL_MS: "10" }),
    /between 50 and 2000 milliseconds/,
  );
  assert.throws(
    () => readOpsPanelConfiguration({ PACKSCOUT_OPS_PANEL_TAIL_MS: "60000" }),
    /between 50 and 2000 milliseconds/,
  );
});

test("origins render IPv6 hosts in brackets", () => {
  assert.equal(panelOrigin("127.0.0.1", 5110), "http://127.0.0.1:5110");
  assert.equal(panelOrigin("::1", 5110), "http://[::1]:5110");
});

test("a taken port produces an actionable message", () => {
  const message = describeStartupFailure(
    Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
    { host: "127.0.0.1", port: 5110 },
  );
  assert.match(message, /already in use/);
  assert.match(message, /http:\/\/127\.0\.0\.1:5110/);
  assert.match(message, /PACKSCOUT_OPS_PANEL_PORT/);
});

test("other startup failures still explain themselves", () => {
  assert.match(
    describeStartupFailure(new Error("boom"), { host: "127.0.0.1", port: 5110 }),
    /failed to start: boom/,
  );
  assert.match(
    describeStartupFailure(
      Object.assign(new Error("denied"), { code: "EACCES" }),
      { host: "127.0.0.1", port: 5110 },
    ),
    /permission denied/,
  );
});
