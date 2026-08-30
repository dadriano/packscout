#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, createCentralDatabaseLifecycle } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillAuthority, readBackfillEnvironment } from "./provider-backfill-supervisor-authority.mts";
import { backfillDigest } from "./provider-backfill-supervisor-policy.mts";
import { collectorRepair as pins, collectorRepairId, CollectorRepairRetryError, refuseCollectorRepair as refuse } from "./collector-reconciliation-retry-plan.mts";
import { inspectCollectorRepair, executeCollectorRepair } from "./collector-reconciliation-retry-control.mts";

export function parseCollectorRepairArguments(args: readonly string[]) {
  if (args.length === 1 && args[0] === "--check-only") return { execute: false, reviewDigest: null };
  if (args.length === 3 && args[0] === "--execute" && args[1] === "--review-digest" && /^[a-f0-9]{64}$/u.test(args[2]!)) {
    return { execute: true, reviewDigest: args[2]! };
  }
  return refuse("COLLECTOR_REPAIR_ARGUMENTS_INVALID");
}
export async function runCollectorRepair(args: ReturnType<typeof parseCollectorRepairArguments>) {
  const environment = await readBackfillEnvironment();
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version, keys: new Map([[environment.version, environment.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central, credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [55434], allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, connectionTimeoutMs: 5000, operationTimeoutMs: 60000 });
  try {
    await central.start();
    const readAuthority = async () => {
      const config = await central.client.provider_config_versions.findUnique({ where: { id: pins.configId },
        select: { provider_id: true, created_by_operator_id: true } });
      if (!config || config.provider_id !== pins.providerId) refuse("COLLECTOR_REPAIR_AUTHORITY_CHANGED");
      const authority = await readBackfillAuthority(central.client, cipher, { organizationId: pins.organizationId,
        providerId: pins.providerId, providerKey: pins.providerKey, configId: pins.configId,
        initialRunId: collectorRepairId("run"), operationId: pins.operationId, operatorId: config.created_by_operator_id });
      return { ...authority, operatorId: config.created_by_operator_id };
    };
    const authority = await readAuthority();
    const result = await gateway.runWithCachedProviderDatabase(authority.route, async (database) => {
      try {
        const state = await database.$transaction(async (tx) => {
          await tx.$executeRaw`set transaction read only`;
          return inspectCollectorRepair(tx, authority);
        }, { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 25000 });
        const reviewDigest = backfillDigest(state.receipt);
        if (!args.execute) return { ok: true as const, value: { phase: state.queued ? "already_queued" : "collector_repair_review",
          reviewDigest, ...state.receipt } };
        if (args.reviewDigest !== reviewDigest) refuse("COLLECTOR_REPAIR_REVIEW_STALE");
        return { ok: true as const, value: await executeCollectorRepair({ database, authority, receipt: state.receipt, readAuthority }) };
      } catch (error) {
        if (error instanceof CollectorRepairRetryError) return { ok: false as const, code: error.code };
        throw error;
      }
    });
    if (result.state !== "reachable") refuse("COLLECTOR_REPAIR_OPERATION_FAILED");
    if (!result.value.ok) refuse(result.value.code);
    return result.value.value;
  } finally { environment.key.fill(0); await gateway.close().catch(() => undefined); await central.close().catch(() => undefined); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCollectorRepair(parseCollectorRepairArguments(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ outcome: "refused", code: error instanceof CollectorRepairRetryError ? error.code : "COLLECTOR_REPAIR_OPERATION_FAILED" })); process.exitCode = 1; }
}
