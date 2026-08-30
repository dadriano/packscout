#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoundedProviderDatabaseGateway,
  PrismaProviderCommandRepository,
  PrismaProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  ProviderDatabaseDestinationPolicy,
  createCentralDatabaseLifecycle,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import { Pool } from "pg";
import {
  loadClutchpacksDataforrestRepositoryEnvironment,
} from "./activate-clutchpacks-dataforrest-source.mts";
import {
  assertNoClutchpacksActivationArguments,
  readClutchpacksDataforrestActivationEnvironment,
} from "./activate-clutchpacks-dataforrest-source-plan.mjs";
import { ClutchpacksReplayCentralRepository } from
  "./prepare-clutchpacks-dataforrest-replay-central.mts";
import {
  CLUTCHPACKS_REPLAY_LEASE_OWNER,
  CLUTCHPACKS_REPLAY_RESUME_IDEMPOTENCY_KEY,
  ClutchpacksReplayPreparationError,
  prepareClutchpacksDataforrestReplay,
  safeClutchpacksReplayPreparationError,
  type ClutchpacksReplayCentralState,
  type ClutchpacksReplayProviderState,
  type ClutchpacksReplayPreparationDependencies,
} from "./prepare-clutchpacks-dataforrest-replay-plan.mts";

const LEASE_MILLISECONDS = 120_000;

function refuse(
  code: ConstructorParameters<typeof ClutchpacksReplayPreparationError>[0],
): never {
  throw new ClutchpacksReplayPreparationError(code);
}

function exactObject(
  value: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length && keys.every(
    (key, index) => key === expectedKeys[index]
      && record[key] === expected[key],
  );
}

async function providerState(
  database: ProviderPrismaClient,
  central: ClutchpacksReplayCentralState,
): Promise<ClutchpacksReplayProviderState> {
  const runtimeRepository = new PrismaProviderRuntimeRepository(database);
  const runtime = await runtimeRepository.snapshot();
  const [worker, storedRuntime, command] = await Promise.all([
    database.provider_worker_states.findUniqueOrThrow({
      where: { worker_role: "import" },
      select: { lease_owner: true },
    }),
    database.provider_runtime.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { source_cursor: true, source_cursor_hash: true },
    }),
    database.control_commands.findUnique({
      where: {
        idempotency_key: CLUTCHPACKS_REPLAY_RESUME_IDEMPOTENCY_KEY,
      },
      select: {
        id: true,
        command_type: true,
        target_run_id: true,
        target_quarantine_id: true,
        expected_generation: true,
        requested_by_operator_id: true,
        reason: true,
        state: true,
        result: true,
        resulting_run_id: true,
      },
    }),
  ]);
  let exactResumeEvidence = false;
  if (command !== null) {
    const audits = await database.local_audit_events.findMany({
      where: { command_id: command.id },
      select: {
        action: true,
        actor_operator_id: true,
        outcome: true,
        details: true,
      },
      orderBy: { sequence: "asc" },
    });
    const transition = audits.find(
      ({ action }) => action === "provider.runtime.transition",
    );
    const terminal = audits.find(
      ({ action }) => action === "provider.command.terminal",
    );
    exactResumeEvidence = command.command_type === "resume"
      && command.target_run_id === null
      && command.target_quarantine_id === null
      && command.requested_by_operator_id === central.operatorId
      && command.reason === null
      && command.state === "completed"
      && command.resulting_run_id === null
      && command.expected_generation + 1n === runtime.generation
      && exactObject(command.result, {
        code: "RUNTIME_TRANSITION_APPLIED",
        generation: runtime.generation.toString(),
        outcome: "accepted",
      })
      && audits.length === 2
      && transition?.actor_operator_id === central.operatorId
      && transition.outcome === "success"
      && exactObject(transition.details, {
        fromState: "error",
        stateGeneration: runtime.generation.toString(),
        toState: "idle",
      })
      && terminal?.actor_operator_id === central.operatorId
      && terminal.outcome === "success"
      && exactObject(terminal.details, {
        commandType: "resume",
        resultCode: "RUNTIME_TRANSITION_APPLIED",
        stateGeneration: runtime.generation.toString(),
      });
  }
  const leaseDisposition = worker.lease_owner === null
    ? "unowned" as const
    : worker.lease_owner === CLUTCHPACKS_REPLAY_LEASE_OWNER
      ? "owned" as const
      : "foreign" as const;
  return Object.freeze({
    providerId: runtime.providerId,
    providerKey: runtime.providerKey as "clutchpacks",
    runtimeState: runtime.state,
    runtimeGeneration: runtime.generation,
    cachedConfigVersionId: runtime.cachedConfiguration?.id ?? null,
    cachedConfigVersionNumber: runtime.cachedConfiguration?.version ?? null,
    activeRunId: runtime.activeRunId,
    leaseDisposition,
    cursorCleared: storedRuntime.source_cursor === null
      && storedRuntime.source_cursor_hash === null,
    exactResumeEvidence,
  });
}

async function routed<T>(
  gateway: BoundedProviderDatabaseGateway,
  central: ClutchpacksReplayCentralState,
  operation: (database: ProviderPrismaClient) => Promise<T>,
): Promise<T> {
  const result = await gateway.runWithAdminProviderDatabase({
    organizationId: central.organizationId,
    providerId: central.providerId,
  }, operation);
  if (result.state !== "reachable") {
    refuse("REPLAY_PROVIDER_STATE_UNEXPECTED");
  }
  return result.value;
}

function productionDependencies(input: Readonly<{
  central: ClutchpacksReplayCentralRepository;
  gateway: BoundedProviderDatabaseGateway;
  providerId: string;
}>): ClutchpacksReplayPreparationDependencies {
  return {
    inspectCentral: () => input.central.inspect(input.providerId),
    inspectProvider: (central) => routed(
      input.gateway,
      central,
      (database) => providerState(database, central),
    ),
    acquireLease: (central) => routed(
      input.gateway,
      central,
      async (database) => {
        const acquired = await new PrismaProviderWorkerLeaseRepository(database)
          .acquire({
            role: "import",
            owner: CLUTCHPACKS_REPLAY_LEASE_OWNER,
            leaseMilliseconds: LEASE_MILLISECONDS,
          });
        if (acquired.kind === "held") {
          refuse("REPLAY_PROVIDER_LEASE_HELD");
        }
        return Object.freeze({ fence: acquired.lease.fence });
      },
    ),
    renewLease: (central, lease) => routed(
      input.gateway,
      central,
      async (database) => {
        const renewed = await new PrismaProviderWorkerLeaseRepository(database)
          .renew({
            role: "import",
            owner: CLUTCHPACKS_REPLAY_LEASE_OWNER,
            fence: lease.fence,
            leaseMilliseconds: LEASE_MILLISECONDS,
          });
        if (renewed === null) refuse("REPLAY_PROVIDER_LEASE_LOST");
        return Object.freeze({ fence: renewed.fence });
      },
    ),
    releaseLease: (central, lease) => routed(
      input.gateway,
      central,
      (database) => new PrismaProviderWorkerLeaseRepository(database).release({
        role: "import",
        owner: CLUTCHPACKS_REPLAY_LEASE_OWNER,
        fence: lease.fence,
      }),
    ),
    appendV4: (central) => input.central.appendV4(central),
    testV4: (central) => input.central.testV4(central),
    activateV4: (central, proof) => input.central.activateV4(central, proof),
    synchronizeProvider: async (central) => {
      const authority = await input.central.authority(central);
      return routed(input.gateway, central, async (database) => {
        const synchronized = await new PrismaProviderRuntimeRepository(database)
          .synchronizeConfiguration({
            centralProviderId: central.providerId,
            providerKey: central.providerKey,
            configVersionId: authority.configVersionId,
            configVersionNumber: authority.configVersionNumber,
            configuration: authority.configuration,
            expiresAt: authority.expiresAt,
            scheduleSeconds: authority.scheduleSeconds,
            nextDueAt: null,
            synchronizedAt: new Date(),
          });
        if (
          synchronized.kind !== "updated"
          && synchronized.kind !== "unchanged"
        ) refuse("REPLAY_PROVIDER_SYNC_FAILED");
        return providerState(database, central);
      });
    },
    resumeProvider: (central, provider) => routed(
      input.gateway,
      central,
      async (database) => {
        const result = await new PrismaProviderCommandRepository(database)
          .submit({
            commandId: randomUUID(),
            idempotencyKey: CLUTCHPACKS_REPLAY_RESUME_IDEMPOTENCY_KEY,
            commandType: "resume",
            targetRunId: null,
            targetQuarantineId: null,
            expectedGeneration: provider.runtimeGeneration,
            requestedByOperatorId: central.operatorId,
            correlationId: randomUUID(),
            reason: null,
            requestedAt: new Date(),
          });
        if (
          result.outcome !== "accepted"
          || result.code !== "RUNTIME_TRANSITION_APPLIED"
        ) refuse("REPLAY_PROVIDER_RESUME_FAILED");
        return providerState(database, central);
      },
    ),
  };
}

export async function runClutchpacksDataforrestReplayPreparationCli(
  input: Readonly<{
    argumentsList?: readonly string[];
    processEnvironment?: NodeJS.ProcessEnv;
    write?: (value: string) => void;
  }> = {},
): Promise<void> {
  assertNoClutchpacksActivationArguments(
    input.argumentsList ?? process.argv.slice(2),
  );
  const processEnvironment = input.processEnvironment ?? process.env;
  let fileEnvironment: Record<string, string> | null = null;
  let environment: ReturnType<
    typeof readClutchpacksDataforrestActivationEnvironment
  > | null = null;
  let centralPool: Pool | null = null;
  let centralLifecycle: ReturnType<
    typeof createCentralDatabaseLifecycle
  > | null = null;
  let gateway: BoundedProviderDatabaseGateway | null = null;
  try {
    fileEnvironment =
      await loadClutchpacksDataforrestRepositoryEnvironment();
    environment = readClutchpacksDataforrestActivationEnvironment({
      processEnvironment,
      fileEnvironment,
    });
    const providerTarget = new URL(environment.providerDatabaseUrl);
    const cipher = new AesGcmProviderCredentialCipher({
      primaryVersion: environment.credentialKeyVersion,
      keys: new Map([[
        environment.credentialKeyVersion,
        environment.credentialKey,
      ]]),
    });
    centralPool = new Pool({
      connectionString: environment.centralDatabaseUrl,
      max: 1,
    });
    centralLifecycle = createCentralDatabaseLifecycle({
      databaseUrl: environment.centralDatabaseUrl,
      connectionLimit: 2,
    });
    gateway = new BoundedProviderDatabaseGateway({
      central: centralLifecycle,
      credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
      destinationPolicy: new ProviderDatabaseDestinationPolicy({
        allowedHosts: [providerTarget.hostname],
        allowedPorts: [Number(providerTarget.port)],
        allowedSslModes: ["disable"],
      }),
      connectionLimitPerProvider: 2,
      maximumCachedProviders: 1,
      operationTimeoutMs: 30_000,
    });
    await centralLifecycle.start();
    const central = new ClutchpacksReplayCentralRepository({
      pool: centralPool,
      cipher,
      activationTargetTester: gateway,
    });
    const result = await prepareClutchpacksDataforrestReplay(
      productionDependencies({
        central,
        gateway,
        providerId: environment.providerId,
      }),
    );
    (input.write ?? ((value) => process.stdout.write(value)))(
      `${JSON.stringify(result)}\n`,
    );
  } finally {
    environment?.credentialKey.fill(0);
    if (fileEnvironment !== null) {
      for (const key of Object.keys(fileEnvironment)) {
        fileEnvironment[key] = "";
        delete fileEnvironment[key];
      }
    }
    await gateway?.close().catch(() => undefined);
    await centralLifecycle?.close().catch(() => undefined);
    await centralPool?.end().catch(() => undefined);
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  runClutchpacksDataforrestReplayPreparationCli().catch((error: unknown) => {
    const safe = safeClutchpacksReplayPreparationError(error);
    console.error(JSON.stringify({
      level: "error",
      event: "clutchpacks_dataforrest_replay_preparation_failed",
      failureCode: safe.code,
    }));
    process.exitCode = 1;
  });
}
