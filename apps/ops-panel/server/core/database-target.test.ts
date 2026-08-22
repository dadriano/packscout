import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATABASE_URL_VARIABLE,
  readDatabaseConnectionSecret,
  requireLocalDatabaseTarget,
  resolveDatabaseTarget,
} from "./database-target.ts";

function target(url?: string) {
  return resolveDatabaseTarget(url === undefined ? {} : { [DATABASE_URL_VARIABLE]: url });
}

test("loopback targets in every spelling classify as local", () => {
  const loopback = [
    "postgresql://packscout:secret@127.0.0.1:5432/packscout_dev",
    "postgres://packscout:secret@localhost:5432/packscout_dev",
    "postgresql://127.0.0.1/packscout_dev",
    "postgresql://127.4.5.6:5432/packscout_dev",
    "postgresql://[::1]:5432/packscout_dev",
    "postgresql://LOCALHOST:5432/packscout_dev",
  ];
  for (const url of loopback) {
    const facts = target(url);
    assert.equal(facts.locality, "local", url);
    assert.equal(facts.localityReason, "loopback_host", url);
    assert.equal(facts.problem, null, url);
  }
});

test("a routable host is never local, however friendly its name", () => {
  const remote = [
    "postgresql://packscout:secret@db.internal.example.com:5432/packscout",
    "postgresql://packscout:secret@10.0.0.5:5432/packscout",
    "postgresql://packscout:secret@0.0.0.0:5432/packscout",
    "postgresql://packscout:secret@localhost.evil.example.com:5432/packscout",
    "postgresql://packscout:secret@127.0.0.1.evil.example.com:5432/packscout",
  ];
  for (const url of remote) {
    const facts = target(url);
    assert.equal(facts.locality, "non_local", url);
    assert.equal(facts.localityReason, "routable_host", url);
  }
});

test("unreadable configuration fails closed rather than reading as unknown", () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, "missing_configuration"],
    ["", "missing_configuration"],
    ["   ", "missing_configuration"],
    ["not a url at all", "unparseable_configuration"],
    ["host=127.0.0.1 port=5432 dbname=packscout", "unparseable_configuration"],
    ["mysql://127.0.0.1:3306/packscout", "unsupported_scheme"],
    ["postgresql:///packscout", "missing_host"],
    ["postgresql://127.0.0.1:5432/", "missing_database_name"],
    ["postgresql://127.0.0.1:5432", "missing_database_name"],
    [
      "postgresql://packscout@127.0.0.1:5432/packscout?host=/var/run/postgresql",
      "ambiguous_host_override",
    ],
  ];
  for (const [url, problem] of cases) {
    const facts = target(url);
    assert.equal(facts.problem, problem, String(url));
    assert.equal(facts.locality, "non_local", String(url));
    assert.equal(facts.localityReason, "unreadable_configuration", String(url));
    assert.equal(facts.identity, null, String(url));
    assert.ok(facts.explanation.length > 0, String(url));
  }
});

test("identity reports host, port, and database, and never credentials", () => {
  const facts = target(
    "postgresql://packscout:sup3r-secret@127.0.0.1:6543/packscout_dev?schema=public",
  );
  assert.deepEqual(facts.identity, {
    host: "127.0.0.1",
    port: 6543,
    database: "packscout_dev",
    displayUrl: "postgresql://127.0.0.1:6543/packscout_dev",
  });
  const serialized = JSON.stringify(facts);
  assert.ok(!serialized.includes("sup3r-secret"));
  assert.ok(!serialized.includes("packscout:"));
});

test("an omitted port reports libpq's default rather than blank", () => {
  assert.equal(target("postgresql://127.0.0.1/packscout_dev").identity?.port, 5432);
});

test("the connection secret is available only through its own reader", () => {
  const env = { [DATABASE_URL_VARIABLE]: " postgresql://a:b@127.0.0.1/db " };
  assert.equal(readDatabaseConnectionSecret(env), "postgresql://a:b@127.0.0.1/db");
  assert.equal(readDatabaseConnectionSecret({}), undefined);
  assert.equal(readDatabaseConnectionSecret({ [DATABASE_URL_VARIABLE]: "  " }), undefined);
});

test("the local-target gate refuses non-local and unreadable targets with an explanation", () => {
  const allowed = requireLocalDatabaseTarget({
    [DATABASE_URL_VARIABLE]: "postgresql://127.0.0.1:5432/packscout_dev",
  });
  assert.equal(allowed.ok, true);

  for (const url of [undefined, "postgresql://db.example.com:5432/packscout", "nonsense"]) {
    const decision = requireLocalDatabaseTarget(
      url === undefined ? {} : { [DATABASE_URL_VARIABLE]: url },
    );
    assert.equal(decision.ok, false);
    if (decision.ok) continue;
    assert.equal(decision.status, 409);
    assert.equal(decision.code, "ops_panel_database_not_local");
    assert.equal(decision.message, decision.target.explanation);
  }
});
