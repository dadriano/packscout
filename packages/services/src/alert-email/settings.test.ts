import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALERT_EMAIL_DEFAULT_WINDOW_MS,
  ALERT_EMAIL_ENABLED_VARIABLE,
  ALERT_EMAIL_MAXIMUM_RECIPIENTS,
  ALERT_EMAIL_RECIPIENTS_VARIABLE,
  ALERT_EMAIL_SEVERITIES_VARIABLE,
  ALERT_EMAIL_WINDOW_MS_VARIABLE,
  resolveAlertEmailRoutingSettings,
} from "./settings.ts";

test("defaults: enabled, critical and warning email, info stays admin-only", () => {
  const settings = resolveAlertEmailRoutingSettings({});
  assert.equal(settings.enabled, true);
  assert.deepEqual(
    [...settings.severities].sort(),
    ["critical", "warning"],
  );
  assert.deepEqual(settings.recipients, []);
  assert.equal(settings.windowMs, ALERT_EMAIL_DEFAULT_WINDOW_MS);
  assert.deepEqual(settings.problems, []);
});

test("the off switch recognizes explicit disable values only", () => {
  for (const value of ["0", "false", "off", "no", " OFF "]) {
    const settings = resolveAlertEmailRoutingSettings({
      [ALERT_EMAIL_ENABLED_VARIABLE]: value,
    });
    assert.equal(settings.enabled, false, value);
    assert.deepEqual(settings.problems, []);
  }
  for (const value of ["1", "true", "on", "yes", ""]) {
    const settings = resolveAlertEmailRoutingSettings({
      [ALERT_EMAIL_ENABLED_VARIABLE]: value,
    });
    assert.equal(settings.enabled, true, value);
    assert.deepEqual(settings.problems, []);
  }
  const garbled = resolveAlertEmailRoutingSettings({
    [ALERT_EMAIL_ENABLED_VARIABLE]: "disabel",
  });
  assert.equal(garbled.enabled, true);
  assert.deepEqual(garbled.problems, ["ALERT_EMAIL_ENABLED_INVALID"]);
});

test("severity routing is configurable and falls back whole on invalid input", () => {
  const criticalOnly = resolveAlertEmailRoutingSettings({
    [ALERT_EMAIL_SEVERITIES_VARIABLE]: "critical",
  });
  assert.deepEqual([...criticalOnly.severities], ["critical"]);
  assert.deepEqual(criticalOnly.problems, []);

  const withInfo = resolveAlertEmailRoutingSettings({
    [ALERT_EMAIL_SEVERITIES_VARIABLE]: " Critical , info ",
  });
  assert.deepEqual([...withInfo.severities].sort(), ["critical", "info"]);

  const invalid = resolveAlertEmailRoutingSettings({
    [ALERT_EMAIL_SEVERITIES_VARIABLE]: "critical,urgent",
  });
  assert.deepEqual([...invalid.severities].sort(), ["critical", "warning"]);
  assert.deepEqual(invalid.problems, ["ALERT_EMAIL_SEVERITIES_INVALID"]);
});

test("recipients parse trimmed, deduplicated, bounded, and visibly lossy", () => {
  const settings = resolveAlertEmailRoutingSettings({
    [ALERT_EMAIL_RECIPIENTS_VARIABLE]:
      " ops@example.com , OPS@example.com, second@example.com ,not-an-address,,",
  });
  assert.deepEqual(settings.recipients, [
    "ops@example.com",
    "second@example.com",
  ]);
  assert.deepEqual(settings.problems, ["ALERT_EMAIL_RECIPIENTS_INVALID"]);

  const many = Array.from(
    { length: ALERT_EMAIL_MAXIMUM_RECIPIENTS + 2 },
    (_, index) => `operator${index}@example.com`,
  ).join(",");
  const truncated = resolveAlertEmailRoutingSettings({
    [ALERT_EMAIL_RECIPIENTS_VARIABLE]: many,
  });
  assert.equal(truncated.recipients.length, ALERT_EMAIL_MAXIMUM_RECIPIENTS);
  assert.deepEqual(truncated.problems, ["ALERT_EMAIL_RECIPIENTS_TRUNCATED"]);
});

test("the flood window is bounded and falls back on unreadable values", () => {
  const custom = resolveAlertEmailRoutingSettings({
    [ALERT_EMAIL_WINDOW_MS_VARIABLE]: "3600000",
  });
  assert.equal(custom.windowMs, 3_600_000);
  assert.deepEqual(custom.problems, []);
  for (const value of ["0", "-5", "59999", "999999999999", "soon"]) {
    const settings = resolveAlertEmailRoutingSettings({
      [ALERT_EMAIL_WINDOW_MS_VARIABLE]: value,
    });
    assert.equal(settings.windowMs, ALERT_EMAIL_DEFAULT_WINDOW_MS, value);
    assert.deepEqual(settings.problems, ["ALERT_EMAIL_WINDOW_INVALID"], value);
  }
});
