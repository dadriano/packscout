import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BoundedProviderDatabaseGateway,
  CentralPrismaClient,
  ProviderPrismaClient,
} from "@packscout/database";
import { CanonicalInspectionError } from "@packscout/services";
import { createDistributedCanonicalInspectionRuntime } from
  "./distributed-canonical-inspection-runtime.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const courtyardId = "10000000-0000-4000-8000-000000000002";
const phygitalsId = "10000000-0000-4000-8000-000000000003";

const providers = [
  {
    id: courtyardId,
    provider_key: "courtyard",
    display_name: "Courtyard",
    lifecycle: "active",
  },
  {
    id: phygitalsId,
    provider_key: "phygitals",
    display_name: "Phygitals",
    lifecycle: "disabled",
  },
] as const;

function centralFixture(): CentralPrismaClient {
  return {
    providers: {
      async findMany() {
        return providers;
      },
      async findFirst(input: {
        readonly where: {
          readonly organization_id: string;
          readonly provider_key: string;
        };
      }) {
        if (input.where.organization_id !== organizationId) return null;
        return providers.find((provider) =>
          provider.provider_key === input.where.provider_key
        ) ?? null;
      },
    },
  } as unknown as CentralPrismaClient;
}

test("central roster survives one independently unreachable provider lane", async () => {
  const routedProviderIds: string[] = [];
  const gateway = {
    async runWithAdminProviderDatabase(input: { readonly providerId: string }) {
      routedProviderIds.push(input.providerId);
      return {
        state: "unreachable" as const,
        providerId: input.providerId,
        failureCode: "database_unreachable" as const,
        observedAt: "2026-08-29T18:00:00.000Z",
        retryHint: "Retry later.",
      };
    },
  } as unknown as Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
  const runtime = createDistributedCanonicalInspectionRuntime({
    central: centralFixture(),
    gateway,
  });

  assert.deepEqual(await runtime.listProviders(organizationId), [
    { platformKey: "courtyard", displayName: "Courtyard", state: "active" },
    { platformKey: "phygitals", displayName: "Phygitals", state: "disabled" },
  ]);
  assert.deepEqual(routedProviderIds, [], "the roster must not probe every lane");

  await assert.rejects(
    () => runtime.summarizeProvider({ organizationId, platformKey: "phygitals" }),
    (error: unknown) =>
      error instanceof CanonicalInspectionError
      && error.code === "CANONICAL_STORE_UNAVAILABLE"
      && error.status === 503,
  );
  assert.deepEqual(routedProviderIds, [phygitalsId]);

  // The provider remains discoverable after its isolated read fails.
  assert.equal((await runtime.listProviders(organizationId)).length, 2);
});

test("provider keys resolve centrally and classified request failures survive routing", async () => {
  const routed: { organizationId: string; providerId: string }[] = [];
  const gateway = {
    async runWithAdminProviderDatabase<T>(
      input: { readonly organizationId: string; readonly providerId: string },
      operation: (database: ProviderPrismaClient) => Promise<T>,
    ) {
      routed.push(input);
      return {
        state: "reachable" as const,
        providerId: input.providerId,
        observedAt: "2026-08-29T18:00:00.000Z",
        value: await operation({} as ProviderPrismaClient),
      };
    },
  } as Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  const runtime = createDistributedCanonicalInspectionRuntime({
    central: centralFixture(),
    gateway,
  });

  await assert.rejects(
    () => runtime.listEntities({
      organizationId,
      platformKey: "courtyard",
      recordKind: "not-a-record-kind",
    }),
    (error: unknown) =>
      error instanceof CanonicalInspectionError
      && error.code === "CANONICAL_RECORD_KIND_INVALID"
      && error.status === 400,
  );
  assert.deepEqual(routed, [{ organizationId, providerId: courtyardId }]);
});

test("an organization cannot resolve another roster's provider key", async () => {
  let routed = false;
  const runtime = createDistributedCanonicalInspectionRuntime({
    central: centralFixture(),
    gateway: {
      async runWithAdminProviderDatabase() {
        routed = true;
        throw new Error("must not route");
      },
    } as unknown as Pick<
      BoundedProviderDatabaseGateway,
      "runWithAdminProviderDatabase"
    >,
  });

  await assert.rejects(
    () => runtime.summarizeProvider({
      organizationId: "10000000-0000-4000-8000-000000000099",
      platformKey: "courtyard",
    }),
    (error: unknown) =>
      error instanceof CanonicalInspectionError
      && error.code === "CANONICAL_PROVIDER_UNKNOWN",
  );
  assert.equal(routed, false);
});
