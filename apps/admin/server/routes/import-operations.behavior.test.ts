import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type { QuarantineEntryDetail, QuarantineEntrySummary } from "@packscout/contracts";
import {
  AuthServiceError,
  ProviderSourceImportRequestError,
  type AuthenticatedActor,
} from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createImportOperationsRouter,
  type ImportOperationsRouterDependencies,
  type ImportRunDetailView,
  type ImportRunSummaryView,
} from "./import-operations.ts";

const origin = "https://admin.packscout.test";
const organizationId = "00000000-0000-4000-8000-000000000010";
const providerId = "00000000-0000-4000-8000-000000000020";
const revisionId = "00000000-0000-4000-8000-000000000021";
const runId = "00000000-0000-4000-8000-000000000030";
const quarantineId = "00000000-0000-4000-8000-000000000040";
const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "00000000-0000-4000-8000-000000000001",
  organizationId,
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Primary Admin",
  state: "active",
  role: "admin",
  permissions: ["providers:view", "imports:start", "imports:retry"],
  csrfToken: "csrf-token",
};
const dataOperator: AuthenticatedActor = {
  ...admin,
  sessionId: "data-session",
  operatorId: "00000000-0000-4000-8000-000000000002",
  role: "data_operator",
};
const viewer: AuthenticatedActor = {
  ...dataOperator,
  sessionId: "viewer-session",
  permissions: ["providers:view"],
};

const counters = {
  pages: 2,
  catalog: 3,
  pulls: 4,
  trades: 5,
  accepted: 9,
  unchanged: 2,
  revised: 1,
  quarantined: 1,
  resolvedQuarantines: 1,
};
const run = {
  id: runId,
  providerId,
  providerName: "Fanatics cards",
  platformKey: "fanatics",
  configurationRevisionId: revisionId,
  configurationVersion: 2,
  trigger: "manual",
  state: "incomplete",
  requestedAt: "2026-08-06T12:00:00.000Z",
  startedAt: "2026-08-06T12:00:01.000Z",
  finishedAt: "2026-08-06T12:01:00.000Z",
  lastProgressAt: "2026-08-06T12:00:55.000Z",
  reachedProviderHead: false,
  counters,
  failure: {
    class: "contract",
    code: "IMPORT_INVALID_CONTRACT",
    summary: "Provider response for private-user and 0xprivate failed the feed contract.",
  },
  rawPayload: { username: "private-user", walletAddress: "0xprivate" },
  bearerToken: "never-serialize",
} as const satisfies ImportRunSummaryView & {
  rawPayload: unknown;
  bearerToken: string;
};
const quarantine = {
  id: quarantineId,
  providerId,
  configurationRevisionId: revisionId,
  platformKey: "fanatics",
  runId,
  pageId: "00000000-0000-4000-8000-000000000031",
  recordKind: "catalog",
  recordIndex: 0,
  externalId: "private-user-wallet-0xprivate",
  reasonCode: "MAPPING_FAILED",
  fieldPath: "item.value",
  sanitizedSummary: "The item value could not be mapped.",
  state: "open",
  attemptCount: 1,
  firstFailureAt: "2026-08-06T12:00:30.000Z",
  latestFailureAt: "2026-08-06T12:00:30.000Z",
  rawExpiresAt: "2026-11-06T12:00:30.000Z",
  resolvedAt: null,
  resolutionSummary: null,
  rawPayload: { username: "private-user" },
  authorization: "Bearer never-serialize",
} as const satisfies QuarantineEntrySummary & {
  rawPayload: unknown;
  authorization: string;
};
const unsafePage = {
  pageNumber: 1,
  requestedCursorPreview: "cursor-start",
  nextCursorPreview: "cursor-next",
  hasMore: true,
  committedAt: "2026-08-06T12:00:30.000Z",
  catalog: 3,
  pulls: 4,
  trades: 5,
  accepted: 9,
  unchanged: 2,
  revised: 1,
  quarantined: 1,
  rawJson: { walletAddress: "0xprivate" },
} as const satisfies ImportRunDetailView["pages"][number] & { rawJson: unknown };
const unsafeTimeline = {
  state: "incomplete",
  occurredAt: "2026-08-06T12:01:00.000Z",
  summary: "Progress remained durable.",
  stack: "private stack",
} as const satisfies ImportRunDetailView["timeline"][number] & { stack: string };
const detail = {
  ...run,
  cursor: {
    requestedPreview: "private-user-cursor-start",
    finalPreview: "wallet-0xprivate-cursor-end",
  },
  pages: [unsafePage],
  timeline: [unsafeTimeline],
  relatedQuarantines: [quarantine],
} as const satisfies ImportRunDetailView & { rawPayload: unknown; bearerToken: string };
const unsafeAttempt = {
  id: "00000000-0000-4000-8000-000000000041",
  state: "failed",
  failureCode: "MAPPING_FAILED",
  fieldPath: "item.value",
  sanitizedSummary: "The item still could not be mapped.",
  canonicalRevisionCount: 0,
  startedAt: "2026-08-06T12:02:00.000Z",
  finishedAt: "2026-08-06T12:02:01.000Z",
  rawPayload: { username: "private-user" },
} as const satisfies QuarantineEntryDetail["attempts"][number] & { rawPayload: unknown };
const quarantineDetail = {
  ...quarantine,
  attempts: [unsafeAttempt],
} as const satisfies QuarantineEntryDetail;

async function withServer(app: Express, runTest: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address, port } = server.address() as AddressInfo;
    await runTest(`http://${address}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function createHarness(
  readOverrides: Partial<ImportOperationsRouterDependencies["reads"]> = {},
  manualImportError?: unknown,
) {
  const calls = { manual: 0, retryOne: 0, retryMany: 0 };
  const organizations: string[] = [];
  const auth: ImportOperationsRouterDependencies["auth"] = {
    async resolveSession({ sessionToken, csrfToken }) {
      if (!sessionToken) throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
      if (csrfToken !== undefined && csrfToken !== "csrf-token") {
        throw new AuthServiceError("FORBIDDEN", "The request could not be verified.", 403);
      }
      return sessionToken === "data-session" ? dataOperator : sessionToken === "viewer-session" ? viewer : admin;
    },
    requirePermission(session, permission) {
      if (!session.permissions.includes(permission)) {
        throw new AuthServiceError("FORBIDDEN", "You do not have permission to perform this action.", 403);
      }
    },
  };
  const reads: ImportOperationsRouterDependencies["reads"] = {
    async listRuns(input) {
      organizations.push(input.organizationId);
      return { items: [run], nextCursor: "run-next" };
    },
    async getRun(input) {
      organizations.push(input.organizationId);
      return detail;
    },
    async listQuarantines(input) {
      organizations.push(input.organizationId);
      return { items: [quarantine], nextCursor: "quarantine-next" };
    },
    ...readOverrides,
  };
  const quarantineService: ImportOperationsRouterDependencies["quarantine"] = {
    async detail() { return quarantineDetail; },
    async retryOne() {
      calls.retryOne += 1;
      return { quarantineId, outcome: "failed", entry: quarantine };
    },
    async retryMany(_actor, input) {
      calls.retryMany += 1;
      return input.quarantineIds.map((id) => ({ quarantineId: id, outcome: "resolved" as const, entry: { ...quarantine, id, state: "resolved" as const } }));
    },
  };
  const cookiePolicy = createSessionCookiePolicy({ production: false, maxAgeMs: 43_200_000 });
  const app = express();
  app.use(express.json());
  app.use("/api", createImportOperationsRouter({
    auth,
    reads,
    manualImports: {
      async request(input) {
        calls.manual += 1;
        assert.equal(input.actor.organizationId, organizationId);
        assert.equal(input.expectedSourceRevisionId, revisionId);
        if (manualImportError !== undefined) throw manualImportError;
        return {
          run: { id: runId, providerId, configurationRevisionId: revisionId, trigger: "manual", state: "queued" },
          deduplicated: input.actor.role === "admin",
        };
      },
    },
    quarantine: quarantineService,
    cookiePolicy,
    sameOrigin: createSameOriginGuard([origin]),
  }));
  return { app, calls, organizations, cookiePolicy };
}

function mutationHeaders(cookieName: string, session = "admin-session") {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: `${cookieName}=${session}`,
    "X-CSRF-Token": "csrf-token",
  };
}

function assertBrowserSafe(serialized: string) {
  assert.doesNotMatch(serialized, /private-user|0xprivate|never-serialize|private stack/);
  assert.doesNotMatch(serialized, /"(?:rawPayload|rawJson|authorization|bearerToken|username|walletAddress)"\s*:/i);
}

test("run and quarantine reads require session, enforce tenant scope, validate bounds, and project browser-safe fields", async () => {
  const { app, organizations, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/import-runs`)).status, 401);
    const invalid = await fetch(`${baseUrl}/api/import-runs?limit=500`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(invalid.status, 422);

    for (const path of [
      "/api/import-runs?state=incomplete&trigger=continuation&limit=25",
      `/api/import-runs/${runId}`,
      "/api/quarantine?state=open&recordKind=trade&limit=25",
      `/api/quarantine/${quarantineId}`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { Cookie: `${cookiePolicy.name}=data-session` },
      });
      assert.equal(response.status, 200);
      assertBrowserSafe(await response.text());
    }
  });
  assert.ok(organizations.length >= 3);
  assert.ok(organizations.every((value) => value === organizationId));
});

test("admin and data operators can request imports while active work deduplicates", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const path = `${baseUrl}/api/data-providers/${providerId}/import-runs`;
    const viewerResponse = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "viewer-session"),
      body: JSON.stringify({ expectedSourceRevisionId: revisionId }),
    });
    assert.equal(viewerResponse.status, 403);

    const crossOrigin = await fetch(path, {
      method: "POST",
      headers: { ...mutationHeaders(cookiePolicy.name, "data-session"), Origin: "https://attacker.test" },
      body: JSON.stringify({ expectedSourceRevisionId: revisionId }),
    });
    assert.equal(crossOrigin.status, 403);

    const operator = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "data-session"),
      body: JSON.stringify({ expectedSourceRevisionId: revisionId }),
    });
    assert.equal(operator.status, 202);
    const operatorBody = await operator.json();
    assert.equal(operatorBody.deduplicated, false);
    assert.equal(operatorBody.outcome, "queued");

    const deduplicated = await fetch(path, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name),
      body: JSON.stringify({ expectedSourceRevisionId: revisionId }),
    });
    assert.equal(deduplicated.status, 200);
    assert.deepEqual(await deduplicated.json(), {
      run: { id: runId, providerId, configurationRevisionId: revisionId, trigger: "manual", state: "queued" },
      deduplicated: true,
      outcome: "coalesced",
    });
  });
  assert.equal(calls.manual, 2);
});

test("Run now exposes an uninstalled integration as a stable provider-scoped error", async () => {
  const { app, calls, cookiePolicy } = createHarness(
    {},
    new ProviderSourceImportRequestError(
      "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
      503,
    ),
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/data-providers/${providerId}/import-runs`,
      {
        method: "POST",
        headers: mutationHeaders(cookiePolicy.name, "data-session"),
        body: JSON.stringify({ expectedSourceRevisionId: revisionId }),
      },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "No source integration is installed for this provider.",
      code: "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
    });
  });
  assert.equal(calls.manual, 1);
});

test("single and bounded bulk retries enforce permissions and return independent safe outcomes", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const single = await fetch(`${baseUrl}/api/quarantine/${quarantineId}/retries`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name, "data-session"),
    });
    assert.equal(single.status, 200);
    const singleBody = await single.text();
    assert.match(singleBody, /"outcome":"failed"/);
    assertBrowserSafe(singleBody);

    const tooMany = Array.from({ length: 51 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    );
    const invalid = await fetch(`${baseUrl}/api/quarantine/retries`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name),
      body: JSON.stringify({ quarantineIds: tooMany }),
    });
    assert.equal(invalid.status, 422);

    const bulk = await fetch(`${baseUrl}/api/quarantine/retries`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy.name),
      body: JSON.stringify({ quarantineIds: [quarantineId] }),
    });
    assert.equal(bulk.status, 200);
    const bulkBody = await bulk.text();
    assert.match(bulkBody, /"outcome":"resolved"/);
    assertBrowserSafe(bulkBody);
  });
  assert.deepEqual(calls, { manual: 0, retryOne: 1, retryMany: 1 });
});

test("reader rate limits map to a stable bounded response", async () => {
  const { app, cookiePolicy } = createHarness({
    async listRuns() {
      throw { code: "RATE_LIMITED", internalDetail: "private throttling key" };
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/import-runs`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: "Too many operation requests. Try again later.",
      code: "RATE_LIMITED",
    });
  });
});
