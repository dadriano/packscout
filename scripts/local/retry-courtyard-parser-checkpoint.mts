#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, createCentralDatabaseLifecycle, locateProviderDatabase } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { loadCollectorCryptDataforrestRepositoryEnvironment } from "./activate-collector-crypt-dataforrest-source.mts";
import { readCollectorCryptDataforrestActivationEnvironment } from "./activate-collector-crypt-dataforrest-source-plan.mjs";
import { assertProviderReviewActivationDatabaseRoute } from "./provider-review-activation-database-proof.mts";
import { readCourtyardHandoffAuthority } from "./courtyard-checkpoint-handoff-central.mts";
import { handoffDigest } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { CourtyardParserRetryError, courtyardParserRetry as pins, assertParserRetryAuthority, refuseParserRetry as refuse } from "./courtyard-parser-checkpoint-retry-plan.mts";
import { inspectParserRetry, executeParserRetry } from "./courtyard-parser-checkpoint-retry-control.mts";

export function parseCourtyardParserRetryArguments(args: readonly string[]) {
  if (args.length === 1 && args[0] === "--check-only") return { execute: false, reviewDigest: null };
  if (args.length === 3 && args[0] === "--execute" && args[1] === "--review-digest" && /^[a-f0-9]{64}$/u.test(args[2]!)) {
    return { execute: true, reviewDigest: args[2]! };
  }
  return refuse("PARSER_RETRY_ARGUMENTS_INVALID");
}
export async function runCourtyardParserRetry(args: ReturnType<typeof parseCourtyardParserRetryArguments>) {
  const environment = readCollectorCryptDataforrestActivationEnvironment({ processEnvironment: process.env,
    fileEnvironment: await loadCollectorCryptDataforrestRepositoryEnvironment() });
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.credentialKeyVersion,
    keys: new Map([[environment.credentialKeyVersion, environment.credentialKey]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central, credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [55433], allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, connectionTimeoutMs: 5000, operationTimeoutMs: 60000 });
  try {
    await central.start();
    const readAuthority = () => readCourtyardHandoffAuthority(central.client, pins.handoffOperationId);
    const authority = await readAuthority(); assertParserRetryAuthority(authority);
    const located = await locateProviderDatabase(central.client, { organizationId: authority.provider.organization_id, providerId: authority.provider.id });
    if (located.state !== "ready") refuse("PARSER_RETRY_AUTHORITY_CHANGED");
    assertProviderReviewActivationDatabaseRoute(located.route, { organizationId: authority.provider.organization_id,
      providerId: authority.provider.id, providerKey: "courtyard", configVersionId: pins.configId, providerRowVersion: authority.provider.row_version,
      topologyVersion: authority.provider.topology_version, nodeId: authority.node.id, nodeRowVersion: authority.node.row_version,
      databaseCredentialVersionId: authority.node.credential.id, host: "127.0.0.1", port: 55433, databaseName: "packscout_courtyard", sslMode: "disable" });
    const result = await gateway.runWithCachedProviderDatabase(located.route, async (database) => {
      try {
        const state = await inspectParserRetry(database, authority);
        const reviewDigest = handoffDigest(state.receipt);
        if (!args.execute) return { ok: true as const, value: { phase: state.queued ? "already_queued" : "parser_repair_retry_review",
          reviewDigest, ...state.receipt } };
        if (args.reviewDigest !== reviewDigest) refuse("PARSER_RETRY_REVIEW_STALE");
        return { ok: true as const, value: await executeParserRetry({ database, authority, receipt: state.receipt, readAuthority }) };
      } catch (error) {
        if (error instanceof CourtyardParserRetryError) return { ok: false as const, code: error.code };
        throw error;
      }
    });
    if (result.state !== "reachable") refuse("PARSER_RETRY_OPERATION_FAILED");
    if (!result.value.ok) refuse(result.value.code);
    return result.value.value;
  } finally { environment.credentialKey.fill(0); await gateway.close().catch(() => undefined); await central.close().catch(() => undefined); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCourtyardParserRetry(parseCourtyardParserRetryArguments(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ outcome: "refused", code: error instanceof CourtyardParserRetryError ? error.code : "PARSER_RETRY_OPERATION_FAILED" })); process.exitCode = 1; }
}
