import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DatabaseOperationDefinition,
  DatabaseOperationsPayload,
  OperationRunSnapshot,
} from "../api/panel-types.ts";
import {
  describeOutputBound,
  readAcknowledgement,
  readOperationOutcome,
  readOperationPane,
  readOperationsAvailability,
  toPaneLine,
} from "./operation-presentation.ts";

function definition(
  overrides: Partial<DatabaseOperationDefinition> = {},
): DatabaseOperationDefinition {
  return {
    id: "reset",
    label: "Reset the database",
    workspaceScript: "db:reset:local",
    acknowledgement: "database_name",
    summary: "Drops, re-migrates, re-seeds.",
    consequence: "Every row is destroyed.",
    destructive: true,
    ...overrides,
  };
}

function run(overrides: Partial<OperationRunSnapshot> = {}): OperationRunSnapshot {
  return {
    runId: "run-1",
    operation: "migrate",
    label: "Apply migrations",
    workspaceScript: "db:prisma:migrate:deploy",
    database: "packscout_dev",
    startedAt: "2026-08-20T09:00:00.000Z",
    finishedAt: null,
    outcome: null,
    message: null,
    outputLineCount: 0,
    outputProduced: 0,
    outputTruncated: false,
    truncationNotice: null,
    interrupted: false,
    ...overrides,
  };
}

function payload(
  overrides: Partial<DatabaseOperationsPayload> = {},
): DatabaseOperationsPayload {
  return {
    readAt: "2026-08-20T09:00:00.000Z",
    target: {
      variableName: "PACKSCOUT_DATABASE_URL",
      configured: true,
      identity: {
        host: "127.0.0.1",
        port: 5432,
        database: "packscout_dev",
        displayUrl: "postgresql://127.0.0.1:5432/packscout_dev",
      },
      locality: "local",
      localityReason: "loopback_host",
      problem: null,
      explanation: "local",
    },
    available: true,
    unavailableReason: null,
    operations: [definition()],
    running: null,
    last: null,
    output: [],
    outputLineLimit: 2_000,
    timeoutMs: 300_000,
    ...overrides,
  };
}

test("each outcome reads as its own state, and unknown is not read as failure", () => {
  assert.equal(readOperationOutcome("succeeded").tone, "ready");
  assert.equal(readOperationOutcome("failed").tone, "danger");
  assert.equal(readOperationOutcome("timed_out").label, "Stopped on timeout");
  assert.equal(readOperationOutcome("unknown").label, "Outcome unknown");
  assert.equal(readOperationOutcome("unknown").tone, "warning");
});

test("the pane is absent until something has run", () => {
  const reading = readOperationPane(null);
  assert.equal(reading.present, false);
  assert.equal(reading.closable, true);
});

test("a running operation holds the pane open", () => {
  const reading = readOperationPane(run());
  assert.equal(reading.running, true);
  assert.equal(reading.closable, false);
  assert.equal(reading.label, "Running");
  assert.match(reading.title, /Apply migrations — packscout_dev/u);
});

test("a settled operation releases the pane", () => {
  const reading = readOperationPane(
    run({ outcome: "succeeded", finishedAt: "2026-08-20T09:01:00.000Z" }),
  );
  assert.equal(reading.running, false);
  assert.equal(reading.closable, true);
  assert.equal(reading.label, "Succeeded");
});

test("truncation and interruption are surfaced as their own notices", () => {
  const reading = readOperationPane(
    run({
      outcome: "unknown",
      interrupted: true,
      outputTruncated: true,
      truncationNotice: "Output stopped being recorded after 3 lines.",
    }),
  );
  assert.equal(reading.notices.length, 2);
  assert.ok(reading.notices.some((notice) => notice.includes("after 3 lines")));
  assert.ok(reading.notices.some((notice) => notice.includes("unknown state")));
});

test("availability comes from the server, never from the client's own reading", () => {
  assert.deepEqual(readOperationsAvailability(null), {
    available: false,
    reason: null,
    busyWith: null,
  });
  assert.equal(readOperationsAvailability(payload()).available, true);

  const blocked = readOperationsAvailability(
    payload({ available: false, unavailableReason: "not local" }),
  );
  assert.equal(blocked.available, false);
  assert.equal(blocked.reason, "not local");

  const busy = readOperationsAvailability(payload({ running: run() }));
  assert.equal(busy.busyWith, "Apply migrations");
});

test("a disruptive operation asks for no typed name", () => {
  const reading = readAcknowledgement(
    definition({ id: "migrate", acknowledgement: "confirm" }),
    "packscout_dev",
    "",
  );
  assert.equal(reading.required, false);
  assert.equal(reading.satisfied, true);
});

test("the destructive one is satisfied only by the exact database name", () => {
  for (const typed of ["", "packscout", "packscout-dev", "PACKSCOUT_DEV"]) {
    assert.equal(
      readAcknowledgement(definition(), "packscout_dev", typed).satisfied,
      false,
      `${typed} must not satisfy the acknowledgement`,
    );
  }
  assert.equal(
    readAcknowledgement(definition(), "packscout_dev", "  packscout_dev ").satisfied,
    true,
  );
});

test("an acknowledgement stops matching when the target drifts underneath it", () => {
  // The operator typed the name they were shown; the payload now names another.
  const reading = readAcknowledgement(definition(), "packscout_other", "packscout_dev");
  assert.equal(reading.satisfied, false);
  assert.match(reading.prompt, /packscout_other/u);
});

test("an unidentifiable target can never satisfy an acknowledgement", () => {
  assert.equal(readAcknowledgement(definition(), "", "").satisfied, false);
});

test("output lines reach the pane with colour codes resolved to plain text", () => {
  const line = toPaneLine({ index: 4, text: "\u001b[32mApplied\u001b[0m 001" });
  assert.deepEqual(line, { index: 4, text: "Applied 001" });
});

test("the pane states the bounds it is subject to", () => {
  const described = describeOutputBound(payload());
  assert.match(described, /2,000 lines/u);
  assert.match(described, /300s/u);
});
