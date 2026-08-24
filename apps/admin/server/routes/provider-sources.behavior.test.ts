import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import {
  AuthServiceError,
  type AuthenticatedActor,
} from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createProviderSourcesRouter,
  type ProviderSourcesRouterDependencies,
} from "./provider-sources.ts";

const origin = "https://admin.packscout.test";
const organizationId = "00000000-0000-4000-8000-000000000001";
const providerId = "00000000-0000-4000-8000-000000000002";
const profileId = "00000000-0000-4000-8000-000000000003";
const sourceId = "00000000-0000-4000-8000-000000000004";
const revisionId = "00000000-0000-4000-8000-000000000005";

const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "00000000-0000-4000-8000-000000000010",
  organizationId,
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Admin",
  state: "active",
  role: "admin",
  permissions: [
    "providers:view",
    "providers:manage",
    "provider_secrets:manage",
    "imports:start",
  ],
  csrfToken: "csrf-token",
};
const operator: AuthenticatedActor = {
  ...admin,
  sessionId: "operator-session",
  operatorId: "00000000-0000-4000-8000-000000000011",
  role: "data_operator",
  permissions: ["providers:view", "imports:start", "imports:retry"],
};

function dependencies() {
  const calls: Array<{ name: string; context: unknown; body?: unknown }> = [];
  const failureAudits: unknown[] = [];
  const actors = new Map([
    ["admin-session", admin],
    ["operator-session", operator],
  ]);
  const auth = {
    async resolveSession(input: { sessionToken?: string; csrfToken?: string }) {
      const actor = input.sessionToken ? actors.get(input.sessionToken) : undefined;
      if (!actor) throw new AuthServiceError("AUTH_REQUIRED", "Sign in.", 401);
      if (input.csrfToken !== undefined && input.csrfToken !== actor.csrfToken) {
        throw new AuthServiceError("FORBIDDEN", "Forbidden.", 403);
      }
      return actor;
    },
    requirePermission(actor: AuthenticatedActor, permission: string) {
      if (!actor.permissions.includes(permission as never)) {
        throw new AuthServiceError("FORBIDDEN", "Forbidden.", 403);
      }
    },
  };
  const audit = {
    actor: "current_operator" as const,
    action: "source_created" as const,
    subjectType: "provider_source" as const,
    subjectId: sourceId,
    revisionId,
    outcome: "success" as const,
    occurredAt: "2026-08-21T12:00:00.000Z",
  };
  const connections = {
    async createProfile(context: unknown, body: unknown) {
      calls.push({ name: "createProfile", context, body });
      return { profileId, revisionId, audit: { ...audit, action: "connection_profile_created", subjectType: "source_connection_profile", subjectId: profileId } };
    },
    async rotateCredential(context: unknown, _id: string, body: unknown) {
      calls.push({ name: "rotateCredential", context, body });
      return { profileId, revisionId, audit };
    },
    async requestTest(context: unknown, _id: string, body: unknown) {
      calls.push({ name: "connectionTest", context, body });
      return { jobId: revisionId, state: "pending", audit };
    },
    async activateRevision(context: unknown, _id: string, body: unknown) {
      calls.push({ name: "activateConnection", context, body });
      return audit;
    },
    async revokeRevision(context: unknown, _id: string, body: unknown) {
      calls.push({ name: "revokeConnection", context, body });
      return audit;
    },
    async createRecoveryRevision(context: unknown, _id: string, body: unknown) {
      calls.push({ name: "createRecoveryRevision", context, body });
      return { profileId, revisionId, audit };
    },
    async requestRecoveryTest(context: unknown, _id: string, body: unknown) {
      calls.push({ name: "requestRecoveryTest", context, body });
      return { jobId: revisionId, state: "pending", audit };
    },
    async activateRecovery(context: unknown, _id: string, body: unknown) {
      calls.push({ name: "activateRecovery", context, body });
      return { runIds: [], audit };
    },
  };
  const sourceMethod = (name: string) => async (
    context: unknown,
    _providerId?: string,
    _sourceId?: string,
    body?: unknown,
  ) => {
    calls.push({ name, context, body });
    return { audit };
  };
  const sources = {
    createSource: sourceMethod("createSource"),
    createReplacement: sourceMethod("createReplacement"),
    requestTest: sourceMethod("sourceTest"),
    activatePaused: sourceMethod("activateSource"),
    reviseInterval: sourceMethod("reviseInterval"),
    pause: sourceMethod("pause"),
    resume: sourceMethod("resume"),
    disable: sourceMethod("disable"),
    previewCursorReset: sourceMethod("previewReset"),
    resetCursor: sourceMethod("resetCursor"),
  };
  return {
    calls,
    dependencies: {
      auth,
      cookiePolicy: createSessionCookiePolicy({
        production: false,
        maxAgeMs: 3_600_000,
      }),
      sameOrigin: createSameOriginGuard([origin]),
      actorKeyer: {
        keyFor({ organizationId: scope, operatorId }: {
          organizationId: string;
          operatorId: string;
        }) {
          return `actor:v1:${scope}:${operatorId}`;
        },
      },
      failureAudit: {
        async recordFailure(input: {
          action: typeof audit.action;
          subjectType: typeof audit.subjectType;
          subjectId: string | null;
          revisionId: string | null;
          safeCode: "SOURCE_CONFLICT";
        }) {
          failureAudits.push(input);
          return {
            actor: "current_operator" as const,
            action: input.action,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            revisionId: input.revisionId,
            outcome: "failure" as const,
            safeCode: input.safeCode,
            occurredAt: "2026-08-21T12:00:01.000Z",
          };
        },
      },
      catalog: {
        async getCatalog(context: unknown) {
          calls.push({ name: "catalog", context });
          return {
            availableSourceTypes: [{
              sourceTypeKey: "dataforrest-events-v1" as const,
              label: "DataForrest events",
            }],
            providers: [{
              id: providerId,
              provider: "courtyard" as const,
              sourceRegistration: {
                sourceTypeKey: "dataforrest-events-v1" as const,
                sourceAdapterVersion: "dataforrest-events-adapter-v1",
                normalizedContractVersion: "provider-observation-v1",
                mapperKey: "courtyard-provider-observation",
                mapperVersion: "1",
                identityNamespaceKey: "dataforrest-courtyard-records-v1",
                recordIdScopes: [
                  "catalog-pack-v1",
                  "catalog-card-v1",
                  "pull-v1",
                  "trade-v1",
                ],
              },
            }],
            connections: [],
            sources: [],
          };
        },
      },
      connections,
      sources,
    } as unknown as ProviderSourcesRouterDependencies,
    failureAudits,
  };
}

async function start(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/api/provider-sources`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

function app(dependencies: ProviderSourcesRouterDependencies) {
  const application = express();
  application.use(express.json());
  application.use("/api/provider-sources", createProviderSourcesRouter(dependencies));
  return application;
}

function headers(session = "admin-session", csrf = "csrf-token") {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: `packscout_session=${session}`,
    "X-CSRF-Token": csrf,
  };
}

test("catalog read requires authentication, remains operator-visible, tenant-scoped, and masked", async () => {
  const fixture = dependencies();
  const server = await start(app(fixture.dependencies));
  try {
    const anonymous = await fetch(server.url);
    assert.equal(anonymous.status, 401);
    const response = await fetch(server.url, {
      headers: { Cookie: "packscout_session=operator-session" },
    });
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(await response.json());
    assert.equal(serialized.includes("bearer"), false);
    assert.deepEqual(fixture.calls.at(-1)?.context, {
      organizationId,
      actorKey: `actor:v1:${organizationId}:${operator.operatorId}`,
    });
  } finally {
    await server.close();
  }
});

test("secret mutation requires secret authority, trusted Origin, CSRF, and strict production input", async () => {
  const fixture = dependencies();
  const server = await start(app(fixture.dependencies));
  const body = {
    sourceTypeKey: "dataforrest-events-v1",
    displayName: "Shared DataForrest",
    endpoint: "https://198.204.245.26.sslip.io/v1/events",
    bearerCredential: "never-return-this-secret",
    requestLimit: 2,
  };
  try {
    for (const request of [
      { headers: headers("operator-session") },
      { headers: { ...headers(), Origin: "https://attacker.test" } },
      { headers: headers("admin-session", "wrong") },
    ]) {
      const response = await fetch(`${server.url}/connections`, {
        method: "POST",
        ...request,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403);
    }
    assert.equal(fixture.failureAudits.length, 0);
    const invalid = await fetch(`${server.url}/connections`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...body, requestLimit: 3 }),
    });
    assert.equal(invalid.status, 422);
    assert.equal(fixture.failureAudits.length, 0);
    const valid = await fetch(`${server.url}/connections`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    assert.equal(valid.status, 201);
    const serialized = JSON.stringify(await valid.json());
    assert.equal(serialized.includes(body.bearerCredential), false);
    assert.equal(fixture.calls.filter(({ name }) => name === "createProfile").length, 1);
    assert.deepEqual(fixture.calls.at(-1)?.context, {
      organizationId,
      actorKey: `actor:v1:${organizationId}:${admin.operatorId}`,
    });
  } finally {
    await server.close();
  }
});

test("configuration and destructive reset are administrator-only and reject malformed tenant targets before service calls", async () => {
  const fixture = dependencies();
  const server = await start(app(fixture.dependencies));
  const resetPath = `${server.url}/providers/${providerId}/sources/${sourceId}/cursor-reset`;
  try {
    const forbidden = await fetch(resetPath, {
      method: "POST",
      headers: headers("operator-session"),
      body: "{}",
    });
    assert.equal(forbidden.status, 403);
    const malformed = await fetch(
      `${server.url}/providers/not-a-uuid/sources/${sourceId}/cursor-reset`,
      { method: "POST", headers: headers(), body: "{}" },
    );
    assert.equal(malformed.status, 422);
    assert.equal(fixture.calls.some(({ name }) => name === "resetCursor"), false);
    const valid = await fetch(resetPath, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        expectedSourceRevisionId: revisionId,
        expectedCursorGeneration: "1",
        expectedCursorFingerprint: null,
        confirmation: "RESET COURTYARD",
      }),
    });
    assert.equal(valid.status, 200);
    assert.equal(fixture.calls.at(-1)?.name, "resetCursor");
  } finally {
    await server.close();
  }
});

test("data operators can pause and resume but cannot revise source configuration", async () => {
  const fixture = dependencies();
  const server = await start(app(fixture.dependencies));
  const source = `${server.url}/providers/${providerId}/sources/${sourceId}`;
  try {
    for (const action of ["pause", "resume"] as const) {
      const response = await fetch(`${source}/${action}`, {
        method: "POST",
        headers: headers("operator-session"),
        body: JSON.stringify({ expectedSourceRevisionId: revisionId }),
      });
      assert.equal(response.status, 200, action);
    }
    const forbidden = await fetch(`${source}/interval`, {
      method: "POST",
      headers: headers("operator-session"),
      body: JSON.stringify({
        expectedSourceRevisionId: revisionId,
        expectedScheduleRevisionId: revisionId,
        intervalSeconds: 180,
      }),
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(
      fixture.calls.filter(({ name }) => ["pause", "resume"].includes(name))
        .map(({ name }) => name),
      ["pause", "resume"],
    );
    assert.equal(fixture.calls.some(({ name }) => name === "reviseInterval"), false);
  } finally {
    await server.close();
  }
});

test("every action body is strictly validated at the HTTP boundary before a service call", async () => {
  const fixture = dependencies();
  const server = await start(app(fixture.dependencies));
  const connection = `${server.url}/connections/${profileId}`;
  const source = `${server.url}/providers/${providerId}/sources/${sourceId}`;
  const exactBodies = [
    [`${connection}/rotate`, {
      expectedRevisionId: revisionId,
      bearerCredential: "replacement-secret",
    }],
    [`${connection}/test`, { expectedRevisionId: revisionId }],
    [`${connection}/activate`, { expectedRevisionId: revisionId }],
    [`${connection}/revoke`, {
      expectedRevisionId: revisionId,
      confirmation: "REVOKE",
    }],
    [`${connection}/recovery-revision`, {
      expectedBlockedRevisionId: revisionId,
      expectedLatestRevisionId: revisionId,
      blockingEpisodeId: null,
      bearerCredential: "recovery-secret",
    }],
    [`${connection}/recovery-test`, {
      expectedRevisionId: revisionId,
      expectedHealthGeneration: "0",
      blockedRevisionId: profileId,
      blockingEpisodeId: null,
    }],
    [`${connection}/recovery-activate`, {
      expectedRevisionId: revisionId,
      expectedHealthGeneration: "0",
      blockedRevisionId: profileId,
      blockingEpisodeId: null,
    }],
    [`${source}/test`, { expectedSourceRevisionId: revisionId }],
    [`${source}/activate`, {
      expectedSourceRevisionId: revisionId,
      expectedConnectionRevisionId: revisionId,
    }],
    [`${source}/interval`, {
      expectedSourceRevisionId: revisionId,
      expectedScheduleRevisionId: revisionId,
      intervalSeconds: 60,
    }],
    [`${source}/pause`, { expectedSourceRevisionId: revisionId }],
    [`${source}/resume`, { expectedSourceRevisionId: revisionId }],
    [`${source}/disable`, { expectedSourceRevisionId: revisionId }],
    [`${source}/cursor-reset-preview`, {
      expectedSourceRevisionId: revisionId,
    }],
    [`${source}/cursor-reset`, {
      expectedSourceRevisionId: revisionId,
      expectedCursorGeneration: "1",
      expectedCursorFingerprint: null,
      confirmation: "RESET courtyard TO FEED START",
    }],
  ] as const;
  try {
    for (const [path, validBody] of exactBodies) {
      for (const body of [{}, { ...validBody, unexpected: "rejected" }]) {
        const before = fixture.calls.length;
        const response = await fetch(path, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 422, path);
        assert.equal(fixture.calls.length, before, path);
        assert.equal((await response.json() as { code: string }).code,
          "INVALID_SOURCE_CONFIGURATION");
      }
    }
    assert.equal(fixture.failureAudits.length, 0);
  } finally {
    await server.close();
  }
});

test("a domain-reached failure returns the exact durable safe audit receipt", async () => {
  const fixture = dependencies();
  (fixture.dependencies.sources as unknown as {
    resume: () => Promise<never>;
  }).resume = async () => {
    throw Object.assign(new Error("must never cross the boundary"), {
      code: "SOURCE_FENCED",
    });
  };
  const server = await start(app(fixture.dependencies));
  try {
    const response = await fetch(
      `${server.url}/providers/${providerId}/sources/${sourceId}/resume`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ expectedSourceRevisionId: revisionId }),
      },
    );
    assert.equal(response.status, 409);
    const body = await response.json() as {
      code: string;
      audit: Record<string, unknown>;
    };
    assert.equal(body.code, "SOURCE_CONFLICT");
    assert.deepEqual(body.audit, {
      actor: "current_operator",
      action: "source_resumed",
      subjectType: "provider_source",
      subjectId: sourceId,
      revisionId,
      outcome: "failure",
      safeCode: "SOURCE_CONFLICT",
      occurredAt: "2026-08-21T12:00:01.000Z",
    });
    assert.deepEqual(fixture.failureAudits, [{
      organizationId,
      actorKey: `actor:v1:${organizationId}:${admin.operatorId}`,
      action: "source_resumed",
      subjectType: "provider_source",
      subjectId: sourceId,
      revisionId,
      safeCode: "SOURCE_CONFLICT",
    }]);
    assert.equal(JSON.stringify(body).includes("must never"), false);
  } finally {
    await server.close();
  }
});

test("duplicate profile and source identity constraints map to stable conflict receipts", async () => {
  const fixture = dependencies();
  let duplicateCode = "P2002";
  fixture.dependencies.connections.createProfile = async () => {
    throw Object.assign(new Error("database detail must stay private"), {
      code: duplicateCode,
    });
  };
  fixture.dependencies.sources.createSource = async () => {
    throw Object.assign(new Error("identity detail must stay private"), {
      code: duplicateCode,
    });
  };
  const server = await start(app(fixture.dependencies));
  try {
    const cases = [
      ["P2002", `${server.url}/connections`, {
        sourceTypeKey: "dataforrest-events-v1",
        displayName: "Shared DataForrest",
        endpoint: "https://198.204.245.26.sslip.io/v1/events",
        bearerCredential: "secret",
        requestLimit: 2,
      }],
      ["SOURCE_IDENTITY_CONFLICT", `${server.url}/sources`, {
        providerId,
        sourceTypeKey: "dataforrest-events-v1",
        connectionProfileId: profileId,
        mapperKey: "courtyard-provider-observation",
        mapperVersion: "1",
        intervalSeconds: 60,
      }],
    ] as const;
    for (const [code, url, body] of cases) {
      duplicateCode = code;
      const response = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 409);
      const payload = await response.json() as {
        code: string;
        audit: { safeCode: string };
      };
      assert.equal(payload.code, "SOURCE_CONFLICT");
      assert.equal(payload.audit.safeCode, "SOURCE_CONFLICT");
      assert.equal(JSON.stringify(payload).includes("detail must stay private"), false);
    }
  } finally {
    await server.close();
  }
});
