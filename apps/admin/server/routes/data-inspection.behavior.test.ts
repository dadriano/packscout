import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { CanonicalInspectionError } from "@packscout/services";
import { createDataInspectionRouter } from "./data-inspection.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";

function actorWith(permissions: string[]): AuthenticatedActor {
  return {
    sessionId: "operator-session",
    operatorId: "00000000-0000-4000-8000-000000000001",
    organizationId,
    organizationName: "PackScout",
    email: "operator@packscout.test",
    displayName: "Data Operator",
    state: "active",
    role: "data_operator",
    permissions: permissions as AuthenticatedActor["permissions"],
    csrfToken: "csrf-token",
  };
}

async function withServer(
  permissions: string[],
  run: (baseUrl: string) => Promise<void>,
  canonical?: Parameters<typeof createDataInspectionRouter>[0]["canonical"],
) {
  const app = express();
  app.use(
    "/api/data-inspection",
    createDataInspectionRouter({
      canonical,
      auth: {
        async resolveSession({ sessionToken }) {
          if (!sessionToken) {
            throw new AuthServiceError(
              "AUTH_REQUIRED",
              "Sign in to continue.",
              401,
            );
          }
          return actorWith(permissions);
        },
        requirePermission(authenticated, permission) {
          assert.equal(permission, "data_inspection:view");
          if (!authenticated.permissions.includes(permission)) {
            throw new AuthServiceError(
              "FORBIDDEN",
              "You do not have permission to perform this action.",
              403,
            );
          }
        },
      },
      cookiePolicy: createSessionCookiePolicy({
        production: false,
        maxAgeMs: 43_200_000,
      }),
    }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("comparison scope is refused without the data-inspection permission", async () => {
  await withServer(["providers:view"], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-inspection/scope`, {
      headers: { cookie: "packscout_session=operator-session" },
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(typeof body.code, "string");
  });
});

test("comparison scope requires a session at all", async () => {
  await withServer(["data_inspection:view"], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-inspection/scope`);
    assert.equal(response.status, 401);
  });
});

test("comparison scope names publishable and pipeline-only kinds", async () => {
  await withServer(["data_inspection:view"], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-inspection/scope`, {
      headers: { cookie: "packscout_session=operator-session" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as {
      entries: {
        canonicalKind: string;
        publishedKind: string | null;
        comparable: boolean;
        reason: string | null;
      }[];
    };
    const byKind = new Map(body.entries.map((entry) => [entry.canonicalKind, entry]));

    // A pack becomes a published repack, so it is comparable.
    assert.equal(byKind.get("pack")?.comparable, true);
    assert.equal(byKind.get("pack")?.publishedKind, "repacks");

    // Pulls and sales stay in the pipeline. Their absence downstream is scope,
    // not loss, so they must carry a stated reason rather than a null one.
    for (const kind of ["pull", "market_event", "ev_input", "estimated_ev"]) {
      assert.equal(byKind.get(kind)?.comparable, false);
      assert.equal(byKind.get(kind)?.publishedKind, null);
      assert.ok((byKind.get(kind)?.reason ?? "").length > 0);
    }
  });
});


/** Records the organization each read was scoped to. */
function canonicalStub(overrides: Record<string, unknown> = {}) {
  const seenOrganizations: string[] = [];
  return {
    seenOrganizations,
    async listProviders(organizationId: string) {
      seenOrganizations.push(organizationId);
      return [
        { platformKey: "courtyard", displayName: "Courtyard", state: "active" },
      ];
    },
    async summarizeProvider(input: { organizationId: string }) {
      seenOrganizations.push(input.organizationId);
      return { platformKey: "courtyard", kinds: [] };
    },
    async listEntities(input: { organizationId: string }) {
      seenOrganizations.push(input.organizationId);
      return { items: [], nextCursor: null };
    },
    async readEntity(input: { organizationId: string }) {
      seenOrganizations.push(input.organizationId);
      throw new CanonicalInspectionError(
        "CANONICAL_ENTITY_UNKNOWN",
        "That record does not exist for this provider.",
        404,
      );
    },
    ...overrides,
  };
}

test("canonical reads are scoped to the caller's own organization", async () => {
  const canonical = canonicalStub();
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      // A foreign organization id in the path must not become the read's scope.
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers/courtyard/summary`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(canonical.seenOrganizations, [organizationId]);
    },
    canonical as never,
  );
});

test("a classified read failure keeps its code and status", async () => {
  const canonical = canonicalStub();
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers/courtyard/entities/pack/missing`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 404);
      const body = (await response.json()) as { code?: string };
      assert.equal(body.code, "CANONICAL_ENTITY_UNKNOWN");
    },
    canonical as never,
  );
});

test("an unclassified read failure surfaces no driver detail", async () => {
  const canonical = canonicalStub({
    async listProviders() {
      throw new Error("connect ECONNREFUSED 10.0.0.4:5432");
    },
  });
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 503);
      const payload = await response.text();
      assert.match(payload, /CANONICAL_STORE_UNAVAILABLE/);
      assert.doesNotMatch(payload, /ECONNREFUSED|5432|10\.0\.0\.4/);
    },
    canonical as never,
  );
});

test("canonical reads are refused without the permission", async () => {
  await withServer(
    ["providers:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 403);
    },
    canonicalStub() as never,
  );
});
