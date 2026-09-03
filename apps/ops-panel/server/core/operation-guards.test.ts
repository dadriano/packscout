import assert from "node:assert/strict";
import { test } from "node:test";
import { findDatabaseOperation } from "./database-operations.ts";
import {
  DATABASE_URL_VARIABLE,
  requireLocalDatabaseTarget,
  type LocalTargetDecision,
} from "./database-target.ts";
import { decideOperationStart, unknownOperationRefusal } from "./operation-guards.ts";

const migrate = findDatabaseOperation("migrate");
const seed = findDatabaseOperation("seed");
const reset = findDatabaseOperation("reset");
assert.ok(migrate && seed && reset);

function localityFor(url: string | undefined): LocalTargetDecision {
  return requireLocalDatabaseTarget(
    url === undefined ? {} : { [DATABASE_URL_VARIABLE]: url },
  );
}

const LOCAL = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
const REMOTE = "postgresql://packscout:hunter2@db.example.com:5432/packscout_dev";

test("a non-local target refuses every operation", () => {
  for (const definition of [migrate, reset]) {
    const decision = decideOperationStart({
      definition,
      locality: localityFor(REMOTE),
      running: null,
      acknowledgement: "packscout_dev",
    });
    assert.equal(decision.ok, false);
    assert.equal(
      decision.ok === false ? decision.code : "",
      "ops_panel_database_not_local",
    );
    assert.equal(decision.ok === false ? decision.status : 0, 409);
  }
});

test("an unconfigured target refuses too, rather than being treated as absent", () => {
  const decision = decideOperationStart({
    definition: migrate,
    locality: localityFor(undefined),
    running: null,
  });
  assert.equal(decision.ok, false);
  assert.equal(
    decision.ok === false ? decision.code : "",
    "ops_panel_database_not_local",
  );
});

test("a second operation is refused with the name of the one already running", () => {
  const decision = decideOperationStart({
    definition: reset,
    locality: localityFor(LOCAL),
    running: {
      operation: "migrate",
      label: "Apply migrations",
      startedAt: "2026-08-20T09:00:00.000Z",
    },
    acknowledgement: "packscout_dev",
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.code, "ops_panel_operation_busy");
  assert.match(decision.message, /Apply migrations is already running/u);
});

test("locality is decided before the lock: a busy panel still refuses a remote target", () => {
  const decision = decideOperationStart({
    definition: migrate,
    locality: localityFor(REMOTE),
    running: {
      operation: "seed",
      label: "Run the seed",
      startedAt: "2026-08-20T09:00:00.000Z",
    },
  });
  assert.equal(
    decision.ok === false ? decision.code : "",
    "ops_panel_database_not_local",
  );
});

test("a target that drifted since the dialog opened is refused as drift, not a typo", () => {
  const decision = decideOperationStart({
    definition: reset,
    locality: localityFor(LOCAL),
    running: null,
    // The operator typed the name they were shown; the environment moved.
    acknowledgement: "packscout_scratch",
    expectedDatabase: "packscout_scratch",
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.code, "ops_panel_operation_target_drifted");
  assert.match(decision.message, /packscout_scratch/u);
  assert.match(decision.message, /packscout_dev/u);
});

test("drift refuses a non-destructive operation as well", () => {
  const decision = decideOperationStart({
    definition: seed,
    locality: localityFor(LOCAL),
    running: null,
    expectedDatabase: "packscout_scratch",
  });
  assert.equal(
    decision.ok === false ? decision.code : "",
    "ops_panel_operation_target_drifted",
  );
});

test("a mistyped acknowledgement refuses the destructive operation", () => {
  const decision = decideOperationStart({
    definition: reset,
    locality: localityFor(LOCAL),
    running: null,
    acknowledgement: "packscout-dev",
    expectedDatabase: "packscout_dev",
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.code, "ops_panel_operation_acknowledgement_mismatch");
  assert.equal(decision.status, 400);
});

test("a missing acknowledgement refuses and says so plainly", () => {
  for (const value of [undefined, null, "", "   ", 42, { database: "packscout_dev" }]) {
    const decision = decideOperationStart({
      definition: reset,
      locality: localityFor(LOCAL),
      running: null,
      acknowledgement: value,
    });
    assert.equal(
      decision.ok === false ? decision.code : "",
      "ops_panel_operation_acknowledgement_mismatch",
      `${JSON.stringify(value)} must not pass as an acknowledgement`,
    );
  }
});

test("a matching acknowledgement admits the destructive operation", () => {
  const decision = decideOperationStart({
    definition: reset,
    locality: localityFor(LOCAL),
    running: null,
    acknowledgement: "  packscout_dev  ",
    expectedDatabase: "packscout_dev",
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.ok === true ? decision.database : "", "packscout_dev");
});

test("a disruptive operation needs no typed name", () => {
  const decision = decideOperationStart({
    definition: seed,
    locality: localityFor(LOCAL),
    running: null,
  });
  assert.equal(decision.ok, true);
});

test("the unknown-operation refusal names the closed vocabulary", () => {
  const refusal = unknownOperationRefusal();
  assert.equal(refusal.status, 400);
  assert.equal(refusal.code, "ops_panel_operation_unknown");
  assert.match(refusal.message, /migrate, seed, reset/u);
});

test("the retired migration action refuses a local target with scoped guidance", () => {
  const decision = decideOperationStart({
    definition: migrate,
    locality: localityFor(LOCAL),
    running: null,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.status, 409);
  assert.equal(decision.code, "ops_panel_operation_unavailable");
  assert.match(decision.message, /central or one provider/u);
  assert.doesNotMatch(decision.message, /hunter2/u);
});
