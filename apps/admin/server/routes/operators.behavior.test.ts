import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import type { OperatorAccountCreatedNotifier } from "../operator-account-created-notice.ts";
import {
  createOperatorsRouter,
  type OperatorInvitationFlow,
  type OperatorsRouterDependencies,
} from "./operators.ts";

const origin = "https://admin.packscout.test";
const operatorId = "00000000-0000-4000-8000-000000000002";
const admin: AuthenticatedActor = {
  sessionId: "admin-session",
  operatorId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000010",
  organizationName: "PackScout",
  email: "admin@packscout.test",
  displayName: "Primary Admin",
  state: "active",
  role: "admin",
  permissions: ["operators:manage"],
  csrfToken: "csrf-token",
};
const dataOperator: AuthenticatedActor = {
  ...admin,
  operatorId,
  role: "data_operator",
  permissions: ["providers:view", "imports:start", "imports:retry"],
};
const operator = {
  id: operatorId,
  email: "operator@packscout.test",
  displayName: "Data Operator",
  state: "active" as const,
  role: "data_operator" as const,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  lastAccessAt: null,
};
const invitedId = "00000000-0000-4000-8000-000000000003";
const invited = {
  ...operator,
  id: invitedId,
  email: "invited@packscout.test",
  displayName: "Invited Operator",
  state: "pending" as const,
};

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address, port } = server.address() as AddressInfo;
    await run(`http://${address}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

interface InvitationOverrides {
  flow?: Partial<OperatorInvitationFlow>;
  /** Omitted entirely, as when the link secret is unconfigured. */
  absent?: boolean;
}

interface AccountCreatedNotificationOverrides {
  notifier?: OperatorAccountCreatedNotifier;
  /** Omitted entirely, as a defensive unconfigured composition. */
  absent?: boolean;
}

function createHarness(
  overrides: Partial<OperatorsRouterDependencies["service"]> = {},
  invitationOverrides: InvitationOverrides = {},
  notificationOverrides: AccountCreatedNotificationOverrides = {},
) {
  const calls = {
    provision: 0,
    directProvision: 0,
    update: 0,
    issue: 0,
    revoke: 0,
    cancel: 0,
    reissueAudits: [] as Array<{ operatorId: string; outcome: string }>,
    issuedFor: [] as Array<{ operatorId: string; invitedByDisplayName: string }>,
    notifiedFor: [] as Array<{ operatorId: string; toEmail: string }>,
  };
  const flow: OperatorInvitationFlow = {
    async issueInvitation(input) {
      calls.issue += 1;
      calls.issuedFor.push({
        operatorId: input.operatorId,
        invitedByDisplayName: input.invitedByDisplayName,
      });
      return {
        status: "issued",
        sentAt: "2026-08-23T12:00:00.000Z",
        expiresAt: "2026-08-30T12:00:00.000Z",
      };
    },
    async revokeInvitations() {
      calls.revoke += 1;
    },
    async describeInvitations(operatorIds) {
      return new Map(
        operatorIds.map((id) => [
          id,
          {
            sentAt: "2026-08-23T12:00:00.000Z",
            expiresAt: "2026-08-30T12:00:00.000Z",
            expired: false,
          },
        ]),
      );
    },
    async acceptInvitation() {
      return { status: "activated" };
    },
    ...invitationOverrides.flow,
  };
  const service: OperatorsRouterDependencies["service"] = {
    async resolveSession({ sessionToken, csrfToken }) {
      if (!sessionToken) {
        throw new AuthServiceError("AUTH_REQUIRED", "Sign in to continue.", 401);
      }
      if (csrfToken !== undefined && csrfToken !== "csrf-token") {
        throw new AuthServiceError(
          "FORBIDDEN",
          "The request could not be verified.",
          403,
        );
      }
      return sessionToken === "data-session" ? dataOperator : admin;
    },
    requirePermission(actor, permission) {
      if (!actor.permissions.includes(permission)) {
        throw new AuthServiceError(
          "FORBIDDEN",
          "You do not have permission to perform this action.",
          403,
        );
      }
    },
    async listOperators() {
      return { items: [operator], nextCursor: null };
    },
    async inviteOperator() {
      calls.provision += 1;
      return { operator: invited };
    },
    async provisionOperator(_actor, input) {
      calls.directProvision += 1;
      return {
        operator: {
          ...operator,
          email: input.email,
          displayName: input.displayName,
          role: input.role,
          state: "active",
        },
      };
    },
    async updateOperator() {
      calls.update += 1;
      return { operator };
    },
    async cancelInvitedOperator() {
      calls.cancel += 1;
      return { operator: { ...invited, state: "cancelled" as const } };
    },
    async resolvePendingOperatorForReissue(_actor, id) {
      return {
        operatorId: id,
        email: invited.email,
        displayName: invited.displayName,
      };
    },
    async recordInvitationReissue(_actor, id, outcome) {
      calls.reissueAudits.push({ operatorId: id, outcome });
    },
    ...overrides,
  };
  const accountCreatedNotifier: OperatorAccountCreatedNotifier =
    notificationOverrides.notifier ?? {
      async notifyOperatorAccountCreated(input) {
        calls.notifiedFor.push(input);
        return { status: "enqueued", deduplicated: false };
      },
    };
  const cookiePolicy = createSessionCookiePolicy({
    production: false,
    maxAgeMs: 12 * 60 * 60 * 1_000,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/operators",
    createOperatorsRouter({
      service,
      cookiePolicy,
      sameOrigin: createSameOriginGuard([origin]),
      ...(invitationOverrides.absent ? {} : { invitations: { flow } }),
      ...(notificationOverrides.absent ? {} : { accountCreatedNotifier }),
    }),
  );
  return { app, calls, cookiePolicy };
}

function mutationHeaders(cookiePolicy: { name: string }, token: string) {
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: `${cookiePolicy.name}=${token}`,
    "X-CSRF-Token": "csrf-token",
  };
}

test("operator reads reject anonymous and data-operator sessions", async () => {
  const { app, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/operators`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    const restricted = await fetch(`${baseUrl}/api/operators`, {
      headers: { Cookie: `${cookiePolicy.name}=data-session` },
    });
    assert.equal(restricted.status, 403);
    assert.equal((await restricted.json()).code, "FORBIDDEN");

    const authorized = await fetch(`${baseUrl}/api/operators`, {
      headers: { Cookie: `${cookiePolicy.name}=admin-session` },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).items[0].role, "data_operator");
  });
});

test("inviting an operator enforces admin, Origin, CSRF, and password-free input", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  const validBody = {
    email: "new@packscout.test",
    displayName: "New Operator",
    role: "data_operator",
  };
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(validBody),
    });
    assert.equal(anonymous.status, 403);

    const restricted = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "data-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(restricted.status, 403);

    const crossOrigin = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: {
        ...mutationHeaders(cookiePolicy, "admin-session"),
        Origin: "https://attacker.test",
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(crossOrigin.status, 403);

    // A password is not merely unnecessary here — the strict schema refuses
    // it, so creation cannot quietly go back to an administrator-set one.
    const withPassword = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ ...validBody, password: "an admin chosen password" }),
    });
    assert.equal(withPassword.status, 422);
    assert.equal((await withPassword.json()).code, "VALIDATION_FAILED");

    const invalid = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ ...validBody, email: "not-an-address" }),
    });
    assert.equal(invalid.status, 422);

    const authorized = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(authorized.status, 201);
    const body = await authorized.json();
    assert.equal(body.operator.state, "pending");
    assert.equal(body.operator.invitation.expired, false);
    assert.equal(typeof body.operator.invitation.sentAt, "string");
    // Nothing token-shaped, link-shaped, or credential-shaped comes back.
    assert.doesNotMatch(
      JSON.stringify(body),
      /token|accept-invitation|password|hash/i,
    );
  });
  assert.equal(calls.provision, 1);
  assert.equal(calls.issue, 1);
  assert.equal(calls.issuedFor[0]?.invitedByDisplayName, "Primary Admin");
});

test("direct provisioning enforces admin, Origin, CSRF, and its strict password contract", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  const validBody = {
    email: "direct@packscout.test",
    displayName: "Direct Operator",
    password: "an initial secure password",
    role: "data_operator",
  };
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-CSRF-Token": "csrf-token",
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");

    const restricted = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "data-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(restricted.status, 403);

    const crossOrigin = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: {
        ...mutationHeaders(cookiePolicy, "admin-session"),
        Origin: "https://attacker.test",
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(crossOrigin.status, 403);

    const missingCsrf = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: `${cookiePolicy.name}=admin-session`,
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(missingCsrf.status, 403);

    const invalidCsrf = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: {
        ...mutationHeaders(cookiePolicy, "admin-session"),
        "X-CSRF-Token": "wrong-token",
      },
      body: JSON.stringify(validBody),
    });
    assert.equal(invalidCsrf.status, 403);

    const weakPassword = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ ...validBody, password: "too short" }),
    });
    assert.equal(weakPassword.status, 422);
    assert.equal((await weakPassword.json()).code, "VALIDATION_FAILED");

    const unknownField = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ ...validBody, state: "active" }),
    });
    assert.equal(unknownField.status, 422);

    const authorized = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(authorized.status, 201);
    const body = await authorized.json();
    assert.equal(body.operator.state, "active");
    assert.deepEqual(body.notification, {
      status: "enqueued",
      deduplicated: false,
    });
    assert.doesNotMatch(
      JSON.stringify(body),
      /initial secure password|passwordHash|"password"/i,
    );
  });
  assert.equal(calls.directProvision, 1);
  assert.deepEqual(calls.notifiedFor, [
    { operatorId, toEmail: "direct@packscout.test" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(calls.notifiedFor),
    /initial secure password|passwordHash|"password"/i,
  );
});

test("a committed direct account stays a 201 when its email cannot be queued", async () => {
  const createWithNotifier = (
    notifier: OperatorAccountCreatedNotifier,
  ) => createHarness({}, {}, { notifier });
  const validBody = {
    email: "direct@packscout.test",
    displayName: "Direct Operator",
    password: "an initial secure password",
    role: "data_operator",
  };

  const failed = createWithNotifier({
    async notifyOperatorAccountCreated() {
      return {
        status: "failed",
        reason: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
      };
    },
  });
  await withServer(failed.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: mutationHeaders(failed.cookiePolicy, "admin-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      operator: {
        ...operator,
        email: validBody.email,
        displayName: validBody.displayName,
        state: "active",
      },
      notification: {
        status: "failed",
        reason: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
      },
    });
  });

  const throwing = createWithNotifier({
    async notifyOperatorAccountCreated() {
      throw new Error(`outbox failed while holding ${validBody.password}`);
    },
  });
  await withServer(throwing.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators/direct`, {
      method: "POST",
      headers: mutationHeaders(throwing.cookiePolicy, "admin-session"),
      body: JSON.stringify(validBody),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.operator.state, "active");
    assert.deepEqual(body.notification, {
      status: "failed",
      reason: "EMAIL_OUTBOX_UNAVAILABLE",
    });
    assert.doesNotMatch(JSON.stringify(body), /initial secure password/i);
  });
});

test("an invitation that cannot be mailed leaves no usable half-provisioned account", async () => {
  const { app, calls, cookiePolicy } = createHarness(
    {},
    {
      flow: {
        async issueInvitation() {
          throw new Error("the outbox refused the intent");
        },
      },
    },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({
        email: "new@packscout.test",
        displayName: "New Operator",
        role: "data_operator",
      }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "SERVICE_UNAVAILABLE");
  });
  // Compensation leaves the account recoverable rather than terminal: any
  // partial link is superseded, but the row is NOT cancelled. Cancelling would
  // reserve the address forever behind the state-blind unique constraint, so
  // the retry the 503 advises would come back as an email conflict with no
  // route out. The account rests pending, and Resend invitation recovers it.
  assert.equal(calls.cancel, 0);
  assert.equal(calls.revoke, 1);
});

test("a failed invitation leaves the address recoverable, and says where to resume", async () => {
  const { app, calls, cookiePolicy } = createHarness(
    {},
    {
      flow: {
        async issueInvitation() {
          throw new Error("delivery unavailable");
        },
      },
    },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({
        email: "new@packscout.test",
        displayName: "New Operator",
        role: "data_operator",
      }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    // The answer must not imply nothing happened: the account exists, and the
    // administrator is told the one place it can be picked up from.
    assert.match(body.error, /operators list/u);
    assert.doesNotMatch(body.error, /Try again shortly/u);
  });
  assert.equal(calls.cancel, 0);
});

test("a reissue that committed is reported as committed even when its audit write fails", async () => {
  // The token and its outbox intent commit atomically inside issueInvitation.
  // Reporting 503 because the audit sink then failed would send the
  // administrator to retry, superseding the link already in the recipient's
  // inbox and handing them one that is dead on arrival.
  const { app, cookiePolicy } = createHarness({
    async recordInvitationReissue(_actor, _operatorId, outcome) {
      if (outcome === "success") throw new Error("audit sink unavailable");
      return undefined;
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/operators/${invited.id}/invitation`,
      {
        method: "POST",
        headers: mutationHeaders(cookiePolicy, "admin-session"),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.invitation.sentAt);
    assert.equal(body.invitation.expired, false);
  });
});

test("reissuing an invitation is permission-guarded, supersedes, and is audited", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "POST", headers: { Origin: origin } },
    );
    assert.equal(anonymous.status, 403);

    const restricted = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "POST", headers: mutationHeaders(cookiePolicy, "data-session") },
    );
    assert.equal(restricted.status, 403);

    const crossOrigin = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      {
        method: "POST",
        headers: {
          ...mutationHeaders(cookiePolicy, "admin-session"),
          Origin: "https://attacker.test",
        },
      },
    );
    assert.equal(crossOrigin.status, 403);

    const authorized = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "POST", headers: mutationHeaders(cookiePolicy, "admin-session") },
    );
    assert.equal(authorized.status, 200);
    const body = await authorized.json();
    assert.equal(body.invitation.expired, false);
    assert.doesNotMatch(JSON.stringify(body), /token|accept-invitation|password/i);
  });
  assert.equal(calls.issue, 1);
  assert.deepEqual(calls.reissueAudits, [
    { operatorId: invitedId, outcome: "success" },
  ]);
});

test("a refused reissue is audited and reported without claiming success", async () => {
  const { app, calls, cookiePolicy } = createHarness(
    {},
    { flow: { async issueInvitation() { return { status: "rate_limited" }; } } },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "POST", headers: mutationHeaders(cookiePolicy, "admin-session") },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "SERVICE_UNAVAILABLE");
  });
  assert.deepEqual(calls.reissueAudits, [
    { operatorId: invitedId, outcome: "blocked" },
  ]);
});

test("cancelling an invitation is permission-guarded and invalidates outstanding links", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const anonymous = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "DELETE", headers: { Origin: origin } },
    );
    assert.equal(anonymous.status, 403);

    const restricted = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "DELETE", headers: mutationHeaders(cookiePolicy, "data-session") },
    );
    assert.equal(restricted.status, 403);

    const authorized = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "DELETE", headers: mutationHeaders(cookiePolicy, "admin-session") },
    );
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).operator.state, "cancelled");
  });
  assert.equal(calls.cancel, 1);
  assert.equal(calls.revoke, 1);
});

test("a cancellation that committed is reported as committed even when supersession fails", async () => {
  // `cancelInvitedOperator` has already written the terminal state and it
  // cannot be taken back from here. Answering with an error because the
  // outstanding links could not be superseded sends the administrator to
  // retry, and the retry answers "not pending" — the operator and the account
  // then describe different outcomes. The stale token is already inert:
  // redemption rechecks account eligibility and a cancelled account fails it.
  const { app, calls, cookiePolicy } = createHarness(
    {},
    {
      flow: {
        async revokeInvitations() {
          calls.revoke += 1;
          throw new Error("the supersession update is unavailable");
        },
      },
    },
  );
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "DELETE", headers: mutationHeaders(cookiePolicy, "admin-session") },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.operator.state, "cancelled");
    // Nothing about a token or a link leaks into the answer.
    assert.doesNotMatch(JSON.stringify(body), /token|accept-invitation|password/i);
  });
  assert.equal(calls.cancel, 1);
  assert.equal(calls.revoke, 1);
});

test("the ledger reports invitation status for pending accounts only", async () => {
  const { app, cookiePolicy } = createHarness({
    async listOperators() {
      return {
        items: [operator, invited, { ...invited, id: "00000000-0000-4000-8000-000000000004", state: "cancelled" as const }],
        nextCursor: null,
      };
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators`, {
      headers: { Cookie: `${cookiePolicy.name}=admin-session` },
    });
    const body = await response.json();
    assert.equal(body.items[0].invitation, undefined);
    assert.equal(body.items[1].invitation.expired, false);
    assert.equal(body.items[2].invitation, undefined);
    assert.doesNotMatch(JSON.stringify(body), /token|accept-invitation|password/i);
  });
});

test("invitation routes report unavailability when the link mechanism is unconfigured", async () => {
  const { app, calls, cookiePolicy } = createHarness({}, { absent: true });
  await withServer(app, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/operators`, {
      method: "POST",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({
        email: "new@packscout.test",
        displayName: "New Operator",
        role: "data_operator",
      }),
    });
    assert.equal(created.status, 503);

    const reissued = await fetch(
      `${baseUrl}/api/operators/${invitedId}/invitation`,
      { method: "POST", headers: mutationHeaders(cookiePolicy, "admin-session") },
    );
    assert.equal(reissued.status, 503);
  });
  // No account is created that nobody could ever be told about.
  assert.equal(calls.provision, 0);
});

test("credential rotation is protected and never echoes credential material", async () => {
  const { app, calls, cookiePolicy } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators/${operatorId}`, {
      method: "PATCH",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ password: "rotated secure password" }),
    });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.doesNotMatch(serialized, /rotated secure password|passwordHash/);
  });
  assert.equal(calls.update, 1);
});

test("last-admin protection returns a stable conflict without claiming success", async () => {
  let updateCalls = 0;
  const { app, cookiePolicy } = createHarness({
    async updateOperator() {
      updateCalls += 1;
      throw new AuthServiceError(
        "LAST_ACTIVE_ADMIN",
        "The last active administrator cannot be disabled or reassigned.",
        409,
      );
    },
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/operators/${admin.operatorId}`, {
      method: "PATCH",
      headers: mutationHeaders(cookiePolicy, "admin-session"),
      body: JSON.stringify({ state: "disabled" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "The last active administrator cannot be disabled or reassigned.",
      code: "LAST_ACTIVE_ADMIN",
    });
  });
  assert.equal(updateCalls, 1);
});
