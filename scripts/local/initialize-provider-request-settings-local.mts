#!/usr/bin/env node
import path from "node:path";
import { open, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy,
  PrismaProviderRequestSettingsRepository, createCentralDatabaseLifecycle,
  type ProviderPrismaClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillAuthority, readBackfillEnvironment } from "./provider-backfill-supervisor-authority.mts";
import { readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import { backfillDigest, ProviderBackfillSupervisorError, refuseBackfill } from "./provider-backfill-supervisor-policy.mts";
import { withContinuousResidency } from "./provider-continuous-residency.mts";
import { assertNoRequestSettingsWriter, assertRequestSettingsInitialization,
  requestSettingsBoundaryDigest, requestSettingsInitializationSchema } from "./initialize-provider-request-settings-policy.mts";

const exec = promisify(execFile);
export function parseRequestSettingsInitializationArguments(args: readonly string[]) {
  if (args[0] !== "--review-file" || !args[1] || !path.isAbsolute(args[1])) refuseBackfill("REQUEST_SETTINGS_ARGUMENTS_INVALID");
  if (args.length === 3 && args[2] === "--check-only") return { file: args[1], digest: null };
  if (args.length === 5 && args[2] === "--apply" && args[3] === "--review-digest" &&
    /^[a-f0-9]{64}$/u.test(args[4]!)) return { file: args[1], digest: args[4]! };
  return refuseBackfill("REQUEST_SETTINGS_ARGUMENTS_INVALID");
}

export async function readRequestSettingsReview(file: string) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8_192) refuseBackfill("REQUEST_SETTINGS_REVIEW_TOO_LARGE");
    const raw = Buffer.alloc(8_193);
    const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
    if (bytesRead > 8_192) refuseBackfill("REQUEST_SETTINGS_REVIEW_TOO_LARGE");
    return requestSettingsInitializationSchema.parse(JSON.parse(raw.subarray(0, bytesRead).toString("utf8")));
  } finally { await handle.close(); }
}

export async function requestSettingsDirectInvocation(argument: string | undefined, moduleUrl = import.meta.url) {
  return argument !== undefined && await realpath(argument) === await realpath(fileURLToPath(moduleUrl));
}

/** Initial setting only: no resume, run, source request, cursor update, or worker launch. */
export async function initializeProviderRequestSettingsLocal(
  args: ReturnType<typeof parseRequestSettingsInitializationArguments>,
) {
  const review = await readRequestSettingsReview(args.file);
  const environment = await readBackfillEnvironment();
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"],
      allowedPorts: [55432, 55433, 55434, 55435], allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationTimeoutMs: 30_000 });
  const assertNoWriter = async () => {
    const processes = await exec("/bin/ps", ["-axo", "pid=,ppid=,command="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    assertNoRequestSettingsWriter(processes.stdout, review.pins.providerId, review.pins.providerKey);
  };
  try {
    await central.start();
    await assertNoWriter();
    const authority = await readBackfillAuthority(central.client, cipher, review.pins);
    let authorizationActive = true;
    // Route acquisition consumes the same budget as the write; it must not
    // grant the callback a fresh deadline after the gateway has timed out.
    const deadline = Date.now() + 25_000;
    const operation = async (database: ProviderPrismaClient) => {
      const assertActive = () => {
        if (!authorizationActive || Date.now() >= deadline) refuseBackfill("REQUEST_SETTINGS_OPERATION_DEADLINE");
      };
      const readBoundary = () => database.$transaction(async transaction => {
        await transaction.$executeRaw`set transaction read only`;
        const snapshot = await readBackfillSnapshot(transaction, review.pins, authority, review.pins.initialRunId);
        const promotion = await transaction.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "promotion" } });
        if (promotion.lease_owner !== null || promotion.lease_expires_at !== null) refuseBackfill("REQUEST_SETTINGS_PROMOTION_OWNED");
        assertRequestSettingsInitialization(review, snapshot, authority.configNumber);
        return snapshot;
      }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 25_000 });
      const repository = new PrismaProviderRequestSettingsRepository(database);
      const before = await readBoundary();
      assertActive();
      const previous = await repository.current({ providerId: review.pins.providerId });
      if (previous !== null) refuseBackfill("REQUEST_SETTINGS_ALREADY_INITIALIZED");
      const boundary = requestSettingsBoundaryDigest(before);
      const digest = backfillDigest({ review, boundary, authority: authority.digest });
      if (args.digest === null) return { outcome: "reviewed", reviewDigest: digest,
        providerId: review.pins.providerId, recordsPerRequest: review.recordsPerRequest,
        checkpointHash: before.checkpointHash, generation: before.generation.toString() };
      if (args.digest !== digest) refuseBackfill("REQUEST_SETTINGS_REVIEW_DRIFT");
      await assertNoWriter();
      const currentAuthority = await readBackfillAuthority(central.client, cipher, review.pins);
      if (currentAuthority.digest !== authority.digest) refuseBackfill("REQUEST_SETTINGS_AUTHORITY_DRIFT");
      assertActive();
      const result = await repository.revise({ providerId: review.pins.providerId, expectedRevisionId: null,
        recordsPerRequest: review.recordsPerRequest, actorOperatorId: review.pins.operatorId,
        correlationId: review.pins.operationId, expectedConfigVersionId: review.pins.configId,
        expectedConfigVersionNumber: authority.configNumber, adapterKey: authority.cachedConfiguration.adapterKey,
        initializationBoundary: { expectedGeneration: BigInt(review.expectedGeneration),
          expectedCursorFingerprint: review.expectedCheckpointHash,
          expectedImportFence: BigInt(review.expectedImportFence), parentRunId: review.pins.initialRunId,
          deadline: new Date(deadline) } });
      if (result.kind !== "updated") refuseBackfill("REQUEST_SETTINGS_INITIALIZATION_REFUSED");
      if (requestSettingsBoundaryDigest(await readBoundary()) !== boundary) refuseBackfill("REQUEST_SETTINGS_POSTCHECK_DRIFT");
      return { outcome: "initialized", providerId: review.pins.providerId,
        requestSettingsRevisionId: result.revision.id, recordsPerRequest: result.revision.recordsPerRequest,
        checkpointHash: before.checkpointHash, generation: before.generation.toString(), reviewDigest: digest };
    };
    // A gateway deadline does not cancel its callback. Drain it before releasing
    // local handoff ownership or credentials, even when the gateway timed out.
    const routed = async () => {
      let pending: ReturnType<typeof operation> | undefined;
      try {
        const outcome = await gateway.runWithCachedProviderDatabase(authority.route, database => {
          pending = operation(database); return pending;
        });
        if (outcome.state !== "reachable") {
          authorizationActive = false;
          refuseBackfill("REQUEST_SETTINGS_PROVIDER_UNAVAILABLE");
        }
        return outcome.value;
      } finally { authorizationActive = false; if (pending) await pending.catch(() => undefined); }
    };
    return args.digest === null ? await routed() : await withContinuousResidency(review.pins,
      () => ({ state: "request_settings_handoff" }), routed);
  } finally { await gateway.close(); await central.close(); environment.key.fill(0); }
}

if (await requestSettingsDirectInvocation(process.argv[1])) {
  Promise.resolve().then(() => initializeProviderRequestSettingsLocal(
    parseRequestSettingsInitializationArguments(process.argv.slice(2)),
  )).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
    process.stderr.write(`${JSON.stringify({ outcome: "blocked", code: error instanceof ProviderBackfillSupervisorError
      ? error.code : "REQUEST_SETTINGS_INITIALIZATION_FAILED" })}\n`); process.exitCode = 1;
  });
}
