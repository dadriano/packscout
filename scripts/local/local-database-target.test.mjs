import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyLocalDatabaseTarget,
  DATABASE_URL_VARIABLE,
  isLoopbackHostname,
} from "./local-database-target.mjs";

function classify(url) {
  return classifyLocalDatabaseTarget(
    url === undefined ? {} : { [DATABASE_URL_VARIABLE]: url },
  );
}

test("a loopback target is local and names its database", () => {
  for (const host of ["127.0.0.1", "localhost", "127.9.9.9", "[::1]"]) {
    const result = classify(`postgresql://packscout:secret@${host}:5432/packscout_dev`);
    assert.equal(result.local, true, `${host} should classify as local`);
    assert.equal(result.database, "packscout_dev");
    assert.equal(result.reason, null);
  }
});

test("local database workflows fail closed on anything they cannot read", () => {
  const cases = [
    [undefined, /is not set/],
    ["", /is not set/],
    ["   ", /is not set/],
    ["not-a-url", /not a connection URL/],
    ["mysql://127.0.0.1:3306/packscout", /does not name a PostgreSQL connection/],
    ["postgresql://127.0.0.1:5432/", /names no database/],
    ["postgresql://127.0.0.1:5432/dev?host=/tmp", /overrides its host/],
    ["postgresql://db.example.com:5432/packscout_live", /not this machine/],
    ["postgresql://10.0.0.4:5432/packscout_live", /not this machine/],
  ];
  for (const [url, pattern] of cases) {
    const result = classify(url);
    assert.equal(result.local, false, `${url} must not classify as local`);
    assert.match(result.reason, pattern);
  }
});

test("loopback detection rejects names that merely look local", () => {
  for (const host of [
    "localhost.attacker.example",
    "127.0.0.1.attacker.example",
    "1270.0.1",
    "127.0.0.256",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isLoopbackHostname(host), false, `${host} must not read as loopback`);
  }
});
