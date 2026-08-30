import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DatabaseOperationsPayload } from "../../api/panel-types.ts";
import { DatabaseOperationsCard } from "./DatabaseOperationsCard.tsx";

function payload(): DatabaseOperationsPayload {
  return {
    readAt: "2026-08-30T02:00:00.000Z",
    target: {
      variableName: "PACKSCOUT_DATABASE_URL", configured: true,
      identity: { host: "127.0.0.1", port: 5432, database: "packscout_dev",
        displayUrl: "postgresql://127.0.0.1:5432/packscout_dev" },
      locality: "local", localityReason: "loopback_host", problem: null,
      explanation: "local",
    },
    available: true, unavailableReason: null, running: null, last: null,
    output: [], outputLineLimit: 2_000, timeoutMs: 300_000,
    operations: [
      { id: "migrate", label: "Apply migrations", workspaceScript: "retired",
        acknowledgement: "confirm", summary: "Migration execution is unavailable.",
        consequence: "No database is changed.", destructive: false,
        unavailableReason: "Choose central or one provider with an explicit scoped CLI command." },
      { id: "seed", label: "Run the seed", workspaceScript: "db:seed:local",
        acknowledgement: "confirm", summary: "Seeds the local database.",
        consequence: "Adds local development rows.", destructive: false },
      { id: "reset", label: "Reset the database", workspaceScript: "db:reset:local",
        acknowledgement: "database_name", summary: "Resets the local database.",
        consequence: "Destroys local rows.", destructive: true },
    ],
  };
}

test("unavailable migration is disabled with an accessible explanation before confirmation", () => {
  const html = renderToStaticMarkup(<DatabaseOperationsCard payload={payload()}
    pending={false} onRun={() => assert.fail("rendering cannot execute an operation")} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-describedby="database-operation-migrate-unavailable"[^>]*>Apply migrations<\/button>/u);
  assert.match(html, /id="database-operation-migrate-unavailable"[^>]*>Choose central or one provider/u);
  assert.match(html, /<button type="button" class="panel-button">Run the seed<\/button>/u);
  assert.match(html, /<button type="button" class="panel-button" data-destructive="yes">Reset the database<\/button>/u);
  assert.doesNotMatch(html, /role="dialog"|Three workflows run/u);
});
