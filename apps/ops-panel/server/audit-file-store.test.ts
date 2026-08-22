import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFileAuditTrailStore } from "./audit-file-store.ts";
import { createAuditTrail } from "./core/audit-trail.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ops-panel-audit-"));
  directories.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("a missing audit file starts an empty trail", async () => {
  const directory = await temporaryDirectory();
  const store = createFileAuditTrailStore(
    path.join(directory, "missing", "audit.json"),
  );
  assert.deepEqual(await store.load(), []);
});

test("the audit trail survives a panel restart on disk", async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, "state", "audit.json");
  const first = await createAuditTrail({
    store: createFileAuditTrailStore(filePath),
  });
  await first.record({
    action: "POST /api/database/migrate",
    method: "POST",
    route: "/api/database/migrate",
    outcome: "rejected",
    reason: "ops_panel_missing_request_header",
  });

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as unknown[];
  assert.equal(persisted.length, 1);

  const restarted = await createAuditTrail({
    store: createFileAuditTrailStore(filePath),
  });
  assert.deepEqual(
    restarted.list().map((entry) => entry.reason),
    ["ops_panel_missing_request_header"],
  );
});

test("a corrupted audit file degrades to an empty trail", async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, "audit.json");
  await writeFile(filePath, "{not json", "utf8");
  const trail = await createAuditTrail({
    store: createFileAuditTrailStore(filePath),
  });
  assert.equal(trail.size(), 0);
});
