import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import type { EmailLinkPurpose } from "@packscout/contracts";
import {
  AuthServiceError,
  createEmailLinkTokenSecurity,
  resolveEmailLinkTokenConfiguration,
  type EmailLinkAuditEventRecord,
  type EnqueueEmailMessageCommand,
} from "@packscout/services";
import { createSameOriginGuard } from "../auth/request-protection.ts";
import {
  createOperatorInvitationFlow,
  type OperatorInvitationTokenStore,
} from "../operator-invitation-runtime.ts";
import { createOperatorInvitationsRouter } from "./operator-invitations.ts";
import type { OperatorInvitationFlow } from "./operators.ts";

/**
 * The invitation journey end to end over the real token mechanism, with only
 * the database swapped for an in-memory store: issue, accept, activate. Every
 * refusal — reused, expired, superseded, cancelled, and simply unknown —
 * is proven to be the same response, and no audit record, log line, or
 * response body is allowed to carry token or password material.
 */

const origin = "https://admin.packscout.test";
const operatorId = "00000000-0000-4000-8000-000000000002";
const otherOperatorId = "00000000-0000-4000-8000-000000000003";
const address = "invited@packscout.test";
const chosenPassword = "a password only I know";
const secret = "a".repeat(48);

interface StoredRow {
  id: string;
  purpose: EmailLinkPurpose;
  subjectId: string;
  addressNormalized: string;
  selector: string;
  verifierHash: string;
  issuedAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  supersededAt: Date | null;
}

function createStore() {
  const rows = new Map<string, StoredRow>();
  const store: OperatorInvitationTokenStore = {
    async issue(input) {
      let superseded = 0;
      for (const row of rows.values()) {
        if (
          row.purpose === input.purpose &&
          row.subjectId === input.subjectId &&
          row.redeemedAt === null &&
          row.supersededAt === null
        ) {
          row.supersededAt = input.issuedAt;
          superseded += 1;
        }
      }
      rows.set(input.selector, {
        ...input,
        redeemedAt: null,
        supersededAt: null,
      });
      return { tokenId: input.id, supersededCount: superseded };
    },
    async findBySelector(selector) {
      return rows.get(selector) ?? null;
    },
    async consume({ tokenId, purpose, now }) {
      for (const row of rows.values()) {
        if (row.id !== tokenId || row.purpose !== purpose) continue;
        if (row.redeemedAt || row.supersededAt || row.expiresAt <= now) {
          return "unavailable";
        }
        row.redeemedAt = now;
        return "consumed";
      }
      return "unavailable";
    },
    async findOutstanding({ purpose, subjectId }) {
      for (const row of [...rows.values()].reverse()) {
        if (
          row.purpose === purpose &&
          row.subjectId === subjectId &&
          row.redeemedAt === null &&
          row.supersededAt === null
        ) {
          return { addressNormalized: row.addressNormalized };
        }
      }
      return null;
    },
    async findOutstandingForSubjects({ purpose, subjectIds }) {
      const outstanding = new Map();
      for (const row of rows.values()) {
        if (
          row.purpose === purpose &&
          subjectIds.includes(row.subjectId) &&
          row.redeemedAt === null &&
          row.supersededAt === null
        ) {
          outstanding.set(row.subjectId, {
            tokenId: row.id,
            addressNormalized: row.addressNormalized,
            issuedAt: row.issuedAt,
            expiresAt: row.expiresAt,
          });
        }
      }
      return outstanding;
    },
    async supersedeOutstanding({ purpose, subjectId, now }) {
      let count = 0;
      for (const row of rows.values()) {
        if (
          row.purpose === purpose &&
          row.subjectId === subjectId &&
          row.redeemedAt === null &&
          row.supersededAt === null
        ) {
          row.supersededAt = now;
          count += 1;
        }
      }
      return count;
    },
  };
  return { store, rows };
}

interface AccountState {
  state: "pending" | "active" | "cancelled";
}

function createHarness(options: { now?: () => Date } = {}) {
  const { store, rows } = createStore();
  const account: AccountState = { state: "pending" };
  const linkAudits: EmailLinkAuditEventRecord[] = [];
  const enqueued: EnqueueEmailMessageCommand[] = [];
  const activations: string[] = [];
  const clock = { now: options.now ?? (() => new Date("2026-08-23T12:00:00.000Z")) };

  const flow = createOperatorInvitationFlow({
    authService: {
      async isOperatorEligibleForInvitation(subjectId, addressNormalized) {
        return (
          subjectId === operatorId &&
          addressNormalized === address &&
          account.state === "pending"
        );
      },
      async activateInvitedOperator(input) {
        if (account.state !== "pending") {
          throw new AuthServiceError(
            "FORBIDDEN",
            "The request could not be verified.",
            403,
          );
        }
        activations.push(input.newPassword);
        account.state = "active";
        return {
          operator: {
            id: operatorId,
            email: address,
            displayName: "Invited Operator",
            state: "active",
            role: "data_operator",
            createdAt: clock.now().toISOString(),
            updatedAt: clock.now().toISOString(),
            lastAccessAt: null,
          },
        };
      },
    },
    security: createEmailLinkTokenSecurity(secret),
    configuration: resolveEmailLinkTokenConfiguration({}),
    throttle: { async recordRequest() { return null; } },
    linkAudit: { async append(event) { linkAudits.push(event); } },
    store,
    clock,
    commitIssuance: async ({ token, message }) => {
      await store.issue(token);
      enqueued.push(message);
    },
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth/invitations",
    createOperatorInvitationsRouter({
      flow,
      sameOrigin: createSameOriginGuard([origin]),
    }),
  );
  return { app, flow, rows, account, linkAudits, enqueued, activations, clock };
}

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { address: host, port } = server.address() as AddressInfo;
    await run(`http://${host}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function issueFor(flow: OperatorInvitationFlow, enqueued: EnqueueEmailMessageCommand[]) {
  const result = await flow.issueInvitation({
    operatorId,
    email: address,
    invitedByDisplayName: "Primary Admin",
    source: "127.0.0.1",
  });
  assert.equal(result.status, "issued");
  const message = enqueued.at(-1);
  const linkPath = (message?.input as { invitationLinkPath: string })
    .invitationLinkPath;
  // The credential rides in the fragment, which browsers never send.
  const url = new URL(linkPath, "https://admin.test");
  assert.equal(url.search, "");
  return {
    token: new URLSearchParams(url.hash.slice(1)).get("token")!,
    message,
  };
}

function accept(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/auth/invitations/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

test("an invited operator activates through the mailed link and the message names who invited them", async () => {
  const harness = createHarness();
  const { token, message } = await issueFor(harness.flow, harness.enqueued);

  assert.equal(message?.kind, "operator_invitation");
  assert.equal(message?.recipient, address);
  assert.match(message?.idempotencyKey ?? "", /^operator_invitation:[0-9a-f-]{36}$/);
  const input = message?.input as {
    invitedByDisplayName: string;
    invitationLinkPath: string;
    linkExpiresAt: string;
  };
  assert.equal(input.invitedByDisplayName, "Primary Admin");
  assert.ok(input.invitationLinkPath.startsWith("/accept-invitation#token="));
  // The credential never rides in the query string of a mailed link.
  assert.equal(input.invitationLinkPath.includes("?"), false);
  assert.ok(Date.parse(input.linkExpiresAt) > harness.clock.now().getTime());

  await withServer(harness.app, async (baseUrl) => {
    const response = await accept(baseUrl, { token, password: chosenPassword });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  });
  assert.equal(harness.account.state, "active");
  assert.deepEqual(harness.activations, [chosenPassword]);
});

test("a link works once: reuse, supersession, expiry, and cancellation share one outcome", async () => {
  const invalid = {
    error:
      "This invitation link is no longer valid. Ask an administrator to send a new one.",
    code: "EMAIL_LINK_INVALID",
  };

  // Reuse.
  const reused = createHarness();
  const first = await issueFor(reused.flow, reused.enqueued);
  await withServer(reused.app, async (baseUrl) => {
    assert.equal(
      (await accept(baseUrl, { token: first.token, password: chosenPassword })).status,
      204,
    );
    const again = await accept(baseUrl, { token: first.token, password: chosenPassword });
    assert.equal(again.status, 410);
    assert.deepEqual(await again.json(), invalid);
  });

  // Supersession: reissuing invalidates the outstanding link.
  const reissued = createHarness();
  const stale = await issueFor(reissued.flow, reissued.enqueued);
  const fresh = await issueFor(reissued.flow, reissued.enqueued);
  assert.notEqual(stale.token, fresh.token);
  await withServer(reissued.app, async (baseUrl) => {
    const old = await accept(baseUrl, { token: stale.token, password: chosenPassword });
    assert.equal(old.status, 410);
    assert.deepEqual(await old.json(), invalid);
    assert.equal(reissued.account.state, "pending");
    assert.equal(
      (await accept(baseUrl, { token: fresh.token, password: chosenPassword })).status,
      204,
    );
  });

  // Expiry.
  let clockNow = new Date("2026-08-23T12:00:00.000Z");
  const expired = createHarness({ now: () => clockNow });
  const aged = await issueFor(expired.flow, expired.enqueued);
  clockNow = new Date("2026-09-30T12:00:00.000Z");
  await withServer(expired.app, async (baseUrl) => {
    const response = await accept(baseUrl, { token: aged.token, password: chosenPassword });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), invalid);
  });
  assert.equal(expired.account.state, "pending");

  // Cancellation: the account leaves `pending` and its links are superseded.
  const cancelled = createHarness();
  const withdrawn = await issueFor(cancelled.flow, cancelled.enqueued);
  cancelled.account.state = "cancelled";
  await cancelled.flow.revokeInvitations(operatorId);
  await withServer(cancelled.app, async (baseUrl) => {
    const response = await accept(baseUrl, {
      token: withdrawn.token,
      password: chosenPassword,
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), invalid);
  });
  assert.equal(cancelled.account.state, "cancelled");

  // An unknown link, a malformed one, and one issued for another subject all
  // read exactly the same — nothing reveals whether an account exists.
  const unknown = createHarness();
  await withServer(unknown.app, async (baseUrl) => {
    for (const token of [
      `${"z".repeat(22)}.${"z".repeat(43)}`,
      "not-a-token",
      "",
    ]) {
      const response = await accept(baseUrl, { token, password: chosenPassword });
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), invalid);
    }
  });
  const foreign = createHarness();
  const foreignLink = await foreign.flow.issueInvitation({
    operatorId: otherOperatorId,
    email: "someone-else@packscout.test",
    invitedByDisplayName: "Primary Admin",
    source: "127.0.0.1",
  });
  assert.equal(foreignLink.status, "issued");
  const foreignToken = new URL(
    (foreign.enqueued.at(-1)?.input as { invitationLinkPath: string })
      .invitationLinkPath,
    "https://admin.test",
  ).searchParams.get("token")!;
  await withServer(foreign.app, async (baseUrl) => {
    const response = await accept(baseUrl, {
      token: foreignToken,
      password: chosenPassword,
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), invalid);
  });
});

test("acceptance requires a trusted Origin and the admin's own password rules", async () => {
  const harness = createHarness();
  const { token } = await issueFor(harness.flow, harness.enqueued);
  await withServer(harness.app, async (baseUrl) => {
    const crossOrigin = await fetch(`${baseUrl}/api/auth/invitations/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.test" },
      body: JSON.stringify({ token, password: chosenPassword }),
    });
    assert.equal(crossOrigin.status, 403);

    const short = await accept(baseUrl, { token, password: "short" });
    assert.equal(short.status, 422);
    const body = await short.json();
    assert.equal(body.code, "VALIDATION_FAILED");
    assert.equal(
      body.details.password[0],
      "Password must be at least 12 characters.",
    );

    const extra = await accept(baseUrl, {
      token,
      password: chosenPassword,
      role: "admin",
    });
    assert.equal(extra.status, 422);
  });
  // Nothing was consumed by a refused request.
  assert.equal(harness.account.state, "pending");
});

test("no token, link, or password reaches any audit record, log line, or response", async () => {
  const harness = createHarness();
  const { token, message } = await issueFor(harness.flow, harness.enqueued);
  const verifier = token.split(".")[1]!;
  await withServer(harness.app, async (baseUrl) => {
    const response = await accept(baseUrl, { token, password: chosenPassword });
    assert.equal(await response.text(), "");
  });

  const serializedAudits = JSON.stringify(harness.linkAudits);
  assert.doesNotMatch(serializedAudits, new RegExp(verifier));
  assert.doesNotMatch(serializedAudits, /accept-invitation/);
  assert.doesNotMatch(serializedAudits, new RegExp(chosenPassword));
  assert.doesNotMatch(serializedAudits, new RegExp(address));
  // The issue and redeem entries are both there, with outcomes.
  assert.deepEqual(
    harness.linkAudits.map((event) => `${event.action}:${event.reason}`),
    ["email_link.issue:issued", "email_link.redeem:redeemed"],
  );

  // The mailed intent is the one place the link legitimately lives, and even
  // there it is a rooted path with no password beside it.
  const serializedMessage = JSON.stringify(message);
  assert.doesNotMatch(serializedMessage, new RegExp(chosenPassword));
  assert.match(serializedMessage, /accept-invitation/);
});
