import assert from "node:assert/strict";
import test from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  type LaunchProviderKey,
} from "@packscout/contracts";
import {
  providerDatabaseTarget,
  type ProviderDatabaseRoute,
  type ProviderPrismaClient,
} from "@packscout/database";
import type { ResolvedDataforrestSourceAuthority } from
  "./dataforrest-source-authority-resolver.ts";
import {
  providerDataforrestLiveIntegrationRegistry,
  type ProviderDataforrestLiveIntegration,
} from "./provider-dataforrest-live-integration.ts";
import { runProviderManualImportLanesOnce } from
  "./provider-manual-import-lane-supervisor.ts";
import { runProviderManualImportOnce } from
  "./provider-manual-import-local-runtime.ts";
import { providerManualImportProcessExitCode } from
  "./provider-manual-import-process-result.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const lanes = Object.freeze([
  {
    providerId: "00000000-0000-4000-8000-000000000020",
    providerKey: "clutchpacks" as const,
    configVersionId: "00000000-0000-4000-8000-000000000030",
    nodeId: "00000000-0000-4000-8000-000000000040",
    credentialVersionId: "00000000-0000-4000-8000-000000000050",
    sourceCredentialVersionId:
      "00000000-0000-4000-8000-000000000060",
  },
  {
    providerId: "00000000-0000-4000-8000-000000000021",
    providerKey: "courtyard" as const,
    configVersionId: "00000000-0000-4000-8000-000000000031",
    nodeId: "00000000-0000-4000-8000-000000000041",
    credentialVersionId: "00000000-0000-4000-8000-000000000051",
    sourceCredentialVersionId:
      "00000000-0000-4000-8000-000000000061",
  },
]);

interface LaneState {
  readonly client: ProviderPrismaClient;
  readonly gatewayId: string;
  readonly commands: string[];
  readonly route: ProviderDatabaseRoute;
  readonly authority: ResolvedDataforrestSourceAuthority;
  readonly integration: ProviderDataforrestLiveIntegration;
  authorityResolver: unknown;
  bootstrapCalls: number;
  leaseOwner: string | null;
  cursor: string | null;
  pages: number;
  routedOperations: number;
}

function laneState(
  lane: (typeof lanes)[number],
  index: number,
): LaneState {
  const adapterKey = lane.providerKey === "clutchpacks"
    ? DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION
    : DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION;
  const integration = providerDataforrestLiveIntegrationRegistry
    .resolve(lane.providerKey, adapterKey);
  if (integration === null) {
    throw new TypeError(`Missing ${lane.providerKey} integration fixture.`);
  }
  return {
    client: { lane: lane.providerKey } as unknown as ProviderPrismaClient,
    gatewayId: `gateway:${lane.providerKey}`,
    commands: [`run:${lane.providerKey}`],
    route: Object.freeze({
      target: providerDatabaseTarget(lane),
      organizationId,
      configVersionId: lane.configVersionId,
      providerRowVersion: BigInt(index + 1),
      topologyVersion: BigInt(index + 1),
      node: Object.freeze({
        nodeId: lane.nodeId,
        host: "127.0.0.1",
        port: 55_432 + index,
        sslMode: "disable",
        credentialVersionId: lane.credentialVersionId,
        encryptedCredential: Object.freeze({
          ciphertext: new Uint8Array([index + 1]),
          nonce: new Uint8Array(12),
          authTag: new Uint8Array(16),
          keyVersion: 1,
        }),
        rowVersion: BigInt(index + 1),
      }),
    }),
    authority: Object.freeze({
      organizationId,
      providerId: lane.providerId,
      providerKey: lane.providerKey,
      configVersionId: lane.configVersionId,
      configVersionNumber: BigInt(index + 1),
      adapterKey: integration.manifest.adapterVersion,
      sourceTypeKey: integration.manifest.sourceTypeKey,
      sourceAdapterVersion: integration.manifest.adapterVersion,
      sourceCredentialVersionId: lane.sourceCredentialVersionId,
      sourceCredentialVersionNumber: BigInt(index + 1),
      expiresAt: null,
      connectionConfiguration: Object.freeze({
        endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
        bearerToken: `fixture-token-${lane.providerKey}`,
      }),
      sourceConfiguration: Object.freeze({ platform: lane.providerKey }),
    }),
    integration,
    authorityResolver: null,
    bootstrapCalls: 0,
    leaseOwner: null,
    cursor: null,
    pages: 0,
    routedOperations: 0,
  };
}

test("lane supervisor overlaps ClutchPacks and Courtyard while isolating failure", {
  timeout: 5_000,
}, async () => {
  const states = new Map<string, LaneState>(lanes.map((lane, index) => [
    lane.providerId,
    laneState(lane, index),
  ]));
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  const arrived = new Set<LaunchProviderKey>();
  let inFlight = 0;
  let maximumInFlight = 0;

  const outcomes = await runProviderManualImportLanesOnce({
    lanes: lanes.map((lane) => ({
      providerId: lane.providerId,
      providerKey: lane.providerKey,
      workerId: `parallel:${lane.providerKey}`,
    })),
    maximumConcurrency: 2,
    runLane(supervisedLane) {
      const lane = lanes.find(
        (candidate) => candidate.providerId === supervisedLane.providerId,
      );
      assert.ok(lane);
      assert.equal(supervisedLane.providerKey, lane.providerKey);
      return runProviderManualImportOnce({
        environment: {
          PACKSCOUT_PROVIDER_ID: supervisedLane.providerId,
          PACKSCOUT_PROVIDER_KEY: supervisedLane.providerKey,
          PACKSCOUT_PROVIDER_WORKER_ID: supervisedLane.workerId,
        },
        fallbackWorkerId: supervisedLane.workerId,
        dependencies: {
      bootstrapProvider(input) {
        assert.deepEqual(input, {
          providerId: lane.providerId,
          providerKey: lane.providerKey,
        });
        const state = states.get(lane.providerId);
        assert.ok(state);
        state.bootstrapCalls += 1;
        return Promise.resolve({
          organizationId,
          providerId: lane.providerId,
          providerKey: lane.providerKey,
          databaseRoute: state.route,
          sourceAuthority: state.authority,
          integration: state.integration,
        });
      },
      async runWithCachedProviderDatabase(route, operation) {
        const state = states.get(route.target.providerId);
        assert.ok(state);
        assert.equal(route, state.route);
        assert.equal(route.organizationId, organizationId);
        assert.equal(route.target.providerKey, lane.providerKey);
        assert.equal(state.gatewayId, `gateway:${lane.providerKey}`);
        state.routedOperations += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        try {
          return {
            state: "reachable" as const,
            value: await operation(state.client),
          };
        } finally {
          inFlight -= 1;
        }
      },
      createExecutor(input) {
        const state = states.get(input.providerId);
        assert.ok(state);
        assert.equal(input.database, state.client);
        assert.equal(input.providerKey, lane.providerKey);
        assert.equal(input.sourceAuthority, state.authority);
        assert.equal(input.integration, state.integration);
        state.authorityResolver ??= input.sourceAuthorityResolver;
        assert.equal(input.sourceAuthorityResolver, state.authorityResolver);
        return {
          terminalizeProgress() {
            throw new Error("A terminal lane must not be terminalized again.");
          },
          async executeNextPage() {
            assert.equal(await input.sourceAuthorityResolver.resolve({
              providerId: lane.providerId,
              providerKey: lane.providerKey,
              configVersionId: lane.configVersionId,
              configVersionNumber: state.authority.configVersionNumber,
              adapterKey: state.integration.manifest.adapterVersion,
            }), state.authority);
            assert.equal(state.leaseOwner, null);
            state.leaseOwner = input.workerId;
            try {
              if (state.pages === 0) {
                assert.deepEqual(state.commands, [`run:${lane.providerKey}`]);
                state.commands.shift();
                state.cursor = `cursor:${lane.providerKey}:page-1`;
                state.pages = 1;
                arrived.add(lane.providerKey);
                if (arrived.size === lanes.length) releaseBarrier();
                await barrier;
                return {
                  kind: "progress" as const,
                  runId: `run:${lane.providerKey}`,
                  pageCount: 1,
                };
              }
              assert.equal(
                state.cursor,
                `cursor:${lane.providerKey}:page-1`,
              );
              if (lane.providerKey === "clutchpacks") {
                return {
                  kind: "failed" as const,
                  runId: `run:${lane.providerKey}`,
                  failureCode: "PROVIDER_CAPTURE_RECORD_INVALID",
                };
              }
              state.cursor = `cursor:${lane.providerKey}:head`;
              state.pages = 2;
              return {
                kind: "completed" as const,
                runId: `run:${lane.providerKey}`,
                pageCount: 2,
                counters: {
                  pages: 2,
                  catalog: 1,
                  pulls: 0,
                  marketEvents: 0,
                  accepted: 1,
                  duplicate: 0,
                  quarantined: 0,
                  materialChanges: 1,
                },
              };
            } finally {
              state.leaseOwner = null;
            }
          },
        };
      },
        },
      });
    },
  });

  assert.equal(maximumInFlight, 2);
  assert.deepEqual(arrived, new Set(["clutchpacks", "courtyard"]));
  assert.deepEqual(outcomes, [
    {
      providerId: lanes[0].providerId,
      providerKey: "clutchpacks",
      status: "fulfilled",
      result: {
        kind: "failed",
        runId: "run:clutchpacks",
        failureCode: "PROVIDER_CAPTURE_RECORD_INVALID",
      },
    },
    {
      providerId: lanes[1].providerId,
      providerKey: "courtyard",
      status: "fulfilled",
      result: {
        kind: "completed",
        runId: "run:courtyard",
        pageCount: 2,
        counters: {
          pages: 2,
          catalog: 1,
          pulls: 0,
          marketEvents: 0,
          accepted: 1,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 1,
        },
      },
    },
  ]);
  assert.equal(providerManualImportProcessExitCode(outcomes), 1);
  const clutch = states.get(lanes[0].providerId);
  const courtyard = states.get(lanes[1].providerId);
  assert.ok(clutch);
  assert.ok(courtyard);
  assert.deepEqual(clutch.commands, []);
  assert.equal(clutch.bootstrapCalls, 1);
  assert.equal(clutch.leaseOwner, null);
  assert.equal(clutch.cursor, "cursor:clutchpacks:page-1");
  assert.equal(clutch.pages, 1);
  assert.equal(clutch.routedOperations, 2);
  assert.deepEqual(courtyard.commands, []);
  assert.equal(courtyard.bootstrapCalls, 1);
  assert.equal(courtyard.leaseOwner, null);
  assert.equal(courtyard.cursor, "cursor:courtyard:head");
  assert.equal(courtyard.pages, 2);
  assert.equal(courtyard.routedOperations, 2);
  assert.notEqual(clutch.gatewayId, courtyard.gatewayId);
  assert.notEqual(clutch.route, courtyard.route);
  assert.notEqual(clutch.authorityResolver, courtyard.authorityResolver);
  assert.notEqual(clutch.client, courtyard.client);
});
