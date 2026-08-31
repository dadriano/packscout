import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createDistributedProviderRequestSettingsRouter,
  DistributedProviderRequestSettingsError,
  type DistributedProviderRequestSettingsRouterDependencies,
} from "./distributed-provider-request-settings.ts";

const id = (value: number) => `81000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const origin = "https://admin.packscout.test";
const actor: AuthenticatedActor = {
  sessionId: id(1), operatorId: id(2), organizationId: id(3),
  organizationName: "Test", email: "admin@packscout.test", displayName: "Admin",
  state: "active", role: "admin", permissions: ["providers:manage"], csrfToken: "csrf",
};
const body = { expectedConfigVersionId: id(5), expectedRequestSettingsRevisionId: id(6), recordsPerRequest: 1_000 };

async function fixture() {
  const calls: Parameters<DistributedProviderRequestSettingsRouterDependencies["requestSettings"]["revise"]>[0][] = [];
  let failure: Error | null = null;
  const cookiePolicy = createSessionCookiePolicy({ production: false, maxAgeMs: 60_000 });
  const app = express();
  app.use(express.json());
  app.use("/api/provider-sources", createDistributedProviderRequestSettingsRouter({
    cookiePolicy,
    sameOrigin: createSameOriginGuard([origin]),
    auth: {
      async resolveSession(input) {
        if (!input.sessionToken) throw new AuthServiceError("AUTH_REQUIRED", "Sign in.", 401);
        if (input.csrfToken !== "csrf") throw new AuthServiceError("FORBIDDEN", "Forbidden.", 403);
        return input.sessionToken === "operator" ? { ...actor, role: "data_operator", permissions: [] } : actor;
      },
      requirePermission(session, permission) {
        if (!session.permissions.includes(permission)) throw new AuthServiceError("FORBIDDEN", "Forbidden.", 403);
      },
    },
    requestSettings: {
      async revise(input) {
        calls.push(input);
        if (failure) throw failure;
        return { requestSettingsRevisionId: id(7), recordsPerRequest: input.request.recordsPerRequest };
      },
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/provider-sources/providers/${id(4)}/sources/${id(4)}`;
  return {
    calls, url,
    fail(error: Error) { failure = error; },
    post(value: unknown, overrides: Record<string, string> = {}, path = "records-per-request") {
      return fetch(`${url}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: `${cookiePolicy.name}=admin`, "x-csrf-token": "csrf", ...overrides },
        body: JSON.stringify(value),
      });
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    cookieName: cookiePolicy.name,
  };
}

test("distributed request size requires same-origin, CSRF and administrator permission before work", async () => {
  const server = await fixture();
  try {
    for (const [headers, status] of [
      [{ origin: "https://attacker.test" }, 403],
      [{ cookie: "" }, 401],
      [{ "x-csrf-token": "" }, 403],
      [{ "x-csrf-token": "wrong" }, 403],
      [{ cookie: `${server.cookieName}=operator` }, 403],
    ] as const) {
      assert.equal((await server.post(body, headers)).status, status);
    }
    assert.equal(server.calls.length, 0);
  } finally { await server.close(); }
});

test("distributed command validates exact pins, 1..5000 integers and route identity without legacy commands", async () => {
  const server = await fixture();
  try {
    for (const recordsPerRequest of [0, 5_001, 1.2, "1000", null]) {
      assert.equal((await server.post({ ...body, recordsPerRequest })).status, 422);
    }
    for (const invalid of [
      { ...body, expectedRequestSettingsRevisionId: null },
      { ...body, organizationId: id(9) },
      { expectedSourceRevisionId: id(5), expectedScheduleRevisionId: id(6), recordsPerRequest: 1_000 },
    ]) assert.equal((await server.post(invalid)).status, 422);
    for (const path of ["test", "interval", "activate", "disable", "cursor-reset", "resume"]) {
      assert.equal((await server.post(body, {}, path)).status, 404);
    }
    assert.equal(server.calls.length, 0);
    const mismatch = await fetch(`${server.url.replace(`/sources/${id(4)}`, `/sources/${id(9)}`)}/records-per-request`, {
      method: "POST", headers: { "content-type": "application/json", origin, cookie: `${server.cookieName}=admin`, "x-csrf-token": "csrf" }, body: JSON.stringify(body),
    });
    assert.equal(mismatch.status, 404);
    for (const recordsPerRequest of [1, 5_000]) {
      const response = await server.post({ ...body, recordsPerRequest });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { requestSettingsRevisionId: id(7), recordsPerRequest });
    }
    assert.deepEqual(server.calls[0], { organizationId: actor.organizationId, operatorId: actor.operatorId, providerId: id(4), request: { ...body, recordsPerRequest: 1 } });
  } finally { await server.close(); }
});

test("distributed command returns bounded conflict and unavailable errors without raw exceptions", async () => {
  const server = await fixture();
  try {
    for (const [error, status, code] of [
      [new DistributedProviderRequestSettingsError("SOURCE_CONFLICT", 409), 409, "SOURCE_CONFLICT"],
      [new DistributedProviderRequestSettingsError("SOURCE_REVISION_CONFLICT", 409), 409, "SOURCE_REVISION_CONFLICT"],
      [new Error("postgres://credential@private-host raw payload"), 503, "SOURCE_OPERATIONS_UNAVAILABLE"],
    ] as const) {
      server.fail(error);
      const response = await server.post(body);
      assert.equal(response.status, status);
      const result = await response.json();
      assert.equal(result.code, code);
      assert.doesNotMatch(JSON.stringify(result), /credential|private-host|raw payload/);
    }
  } finally { await server.close(); }
});
