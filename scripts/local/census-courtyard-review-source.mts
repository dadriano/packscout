import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
} from "@packscout/contracts";
import {
  createCentralDatabaseLifecycle,
  providerMixedCursorFingerprint,
  validateProviderMixedPage,
  type CanonicalJsonValue,
} from "@packscout/database";
import { AesGcmProviderCredentialCipher } from "@packscout/services";
import {
  CentralDataforrestSourceAuthorityResolver,
  StaticDataforrestSourceAuthorityResolver,
  type ResolvedDataforrestSourceAuthority,
} from "../../apps/worker/src/dataforrest-source-authority-resolver.ts";
import { providerDataforrestLiveIntegrationRegistry } from
  "../../apps/worker/src/provider-dataforrest-live-integration.ts";
import { ProviderDataforrestMixedPageSource } from
  "../../apps/worker/src/provider-dataforrest-mixed-page-source.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
dotenv.config({ path: path.join(workspaceRoot, ".env") });

const providerKey = "courtyard" as const;
const maximumPages = 50_000;
const progressIntervalPages = 200;

interface CensusTranslationReceipt {
  readonly pageNumber: number;
  readonly sourceRecordCount: number;
  readonly normalizedRecordCount: number;
}

function refuse(code: string): never {
  throw new Error(code);
}

function required(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || /[\r\n\0]/u.test(normalized)) {
    return refuse("COURTYARD_CENSUS_CONFIGURATION_INVALID");
  }
  return normalized;
}

function centralDatabaseUrl(): string {
  try {
    const parsed = new URL(required(process.env.PACKSCOUT_CENTRAL_DATABASE_URL));
    if (
      (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:")
      || parsed.hostname.length === 0
      || parsed.pathname.length < 2
    ) {
      return refuse("COURTYARD_CENSUS_CONFIGURATION_INVALID");
    }
    return parsed.toString();
  } catch {
    return refuse("COURTYARD_CENSUS_CONFIGURATION_INVALID");
  }
}

function credentialCipher(): AesGcmProviderCredentialCipher {
  const encoded = required(
    process.env.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
  );
  const key = Buffer.from(encoded, "base64");
  const version = Number(
    process.env.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION?.trim() ?? "1",
  );
  if (
    key.byteLength !== 32
    || key.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
    || !Number.isInteger(version)
    || version < 1
  ) {
    key.fill(0);
    return refuse("COURTYARD_CENSUS_CONFIGURATION_INVALID");
  }
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: version,
    keys: new Map([[version, new Uint8Array(key)]]),
  });
  key.fill(0);
  return cipher;
}

async function bootstrapAuthority(): Promise<ResolvedDataforrestSourceAuthority> {
  const central = createCentralDatabaseLifecycle({
    databaseUrl: centralDatabaseUrl(),
    connectionLimit: 1,
  });
  try {
    await central.start();
    const provider = await central.client.providers.findFirst({
      where: { provider_key: providerKey },
      select: {
        id: true,
        lifecycle: true,
        active_config_version_id: true,
        active_config_version: {
          select: {
            id: true,
            version_number: true,
            adapter_key: true,
          },
        },
      },
    });
    const config = provider?.active_config_version ?? null;
    const adapterKey = config?.adapter_key
      ?? DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION;
    const integration = providerDataforrestLiveIntegrationRegistry.resolve(
      providerKey,
      adapterKey,
    );
    if (integration === null) {
      return refuse("COURTYARD_CENSUS_CAPABILITY_UNAVAILABLE");
    }
    if (
      provider === null
      || provider.lifecycle !== "active"
      || provider.active_config_version_id === null
      || config === null
      || config.id !== provider.active_config_version_id
      || config.adapter_key !== integration.manifest.adapterVersion
    ) {
      return refuse("COURTYARD_CENSUS_AUTHORITY_UNAVAILABLE");
    }
    return await new CentralDataforrestSourceAuthorityResolver({
      central: central.client,
      credentialCipher: credentialCipher(),
    }).resolve({
      providerId: provider.id,
      providerKey,
      configVersionId: config.id,
      configVersionNumber: config.version_number,
      adapterKey: config.adapter_key,
    });
  } finally {
    await central.close();
  }
}

function candidateIdentity(
  candidate: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = candidate[field];
  if (typeof value !== "string" || value.length === 0) {
    return refuse("COURTYARD_CENSUS_CANONICAL_IDENTITY_INVALID");
  }
  return value;
}

async function run(): Promise<void> {
  if (DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS !== 100) {
    return refuse("COURTYARD_CENSUS_PAGE_BOUND_INVALID");
  }
  const authority = await bootstrapAuthority();
  const integration = providerDataforrestLiveIntegrationRegistry.resolve(
    providerKey,
    authority.adapterKey,
  );
  if (integration === null) {
    return refuse("COURTYARD_CENSUS_CAPABILITY_UNAVAILABLE");
  }
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let maximumResponseBytes = 0;
  let pendingTranslation: Readonly<CensusTranslationReceipt> | null = null;
  const source = new ProviderDataforrestMixedPageSource({
    authorityResolver: new StaticDataforrestSourceAuthorityResolver({
      authority,
    }),
    integration,
    workerId: "local:courtyard-source-census",
    // This local census intentionally has no durable audit surface and never
    // commits a page. Production imports use the provider-local audit recorder.
    terminalizeRequest: async (attempt) => {
      maximumResponseBytes = Math.max(
        maximumResponseBytes,
        attempt.outcome.measurements.responseBytes,
      );
      return Object.freeze({
        requestAttemptId: attempt.requestAttemptId,
        requestLeaseId: attempt.requestLeaseId,
        operationScope: attempt.operationScope,
      });
    },
    translationRecorder: {
      recordPageTranslation(input) {
        pendingTranslation = Object.freeze({
          pageNumber: input.pageNumber,
          sourceRecordCount: input.sourceRecordCount,
          normalizedRecordCount: input.normalizedRecordCount,
        });
        return Promise.resolve({ kind: "recorded" as const });
      },
    },
  });

  const identities = {
    categories: new Set<string>(),
    packs: new Set<string>(),
    collectibles: new Set<string>(),
    pulls: new Set<string>(),
    marketEvents: new Set<string>(),
    quarantines: new Set<string>(),
  };
  let checkpoint: CanonicalJsonValue | null = null;
  let checkpointFingerprint: string | null = null;
  let sourceRecords = 0;
  let mixedRecords = 0;
  let catalogRecordOccurrences = 0;
  let pullRecordOccurrences = 0;
  let marketEventRecordOccurrences = 0;
  let completed = false;
  let completedPages = 0;
  const startedAt = Date.now();
  const runId = randomUUID();

  try {
    for (let pageNumber = 1; pageNumber <= maximumPages; pageNumber += 1) {
      if (abort.signal.aborted) return refuse("COURTYARD_CENSUS_ABORTED");
      pendingTranslation = null;
      const page = validateProviderMixedPage(await source.nextPage({
        authority: {
          providerId: authority.providerId,
          providerKey,
          configVersionId: authority.configVersionId,
          configVersionNumber: authority.configVersionNumber,
          configuration: { adapterKey: authority.adapterKey },
        },
        runId,
        workerFence: 1n,
        pageNumber,
        sourceCheckpoint: checkpoint,
        sourceCheckpointFingerprint: checkpointFingerprint,
        signal: abort.signal,
      }));
      // The recorder runs inside source.nextPage; the assertion makes that
      // callback-owned mutation visible to TypeScript's local control flow.
      const translation = pendingTranslation as
        Readonly<CensusTranslationReceipt> | null;
      if (translation === null || translation.pageNumber !== pageNumber) {
        return refuse("COURTYARD_CENSUS_TRANSLATION_RECEIPT_INVALID");
      }
      sourceRecords += translation.sourceRecordCount;
      mixedRecords += page.records.length;
      completedPages = pageNumber;

      for (const record of page.records) {
        if (record.disposition === "quarantine") {
          if (
            typeof record.sourceRecordKey !== "string"
            || record.sourceRecordKey.length === 0
          ) {
            return refuse("COURTYARD_CENSUS_CANONICAL_IDENTITY_INVALID");
          }
          identities.quarantines.add(record.sourceRecordKey);
          continue;
        }
        if (record.kind === "catalog") {
          catalogRecordOccurrences += 1;
          if (record.entityType === "category") {
            identities.categories.add(candidateIdentity(
              record.candidate,
              "categoryKey",
            ));
          } else if (record.entityType === "pack") {
            identities.packs.add(candidateIdentity(record.candidate, "packKey"));
          } else if (record.entityType === "collectible") {
            identities.collectibles.add(candidateIdentity(
              record.candidate,
              "collectibleKey",
            ));
          }
        } else if (record.kind === "pull") {
          pullRecordOccurrences += 1;
          identities.pulls.add(candidateIdentity(record.candidate, "pullKey"));
        } else if (record.kind === "market_event") {
          marketEventRecordOccurrences += 1;
          identities.marketEvents.add(candidateIdentity(
            record.candidate,
            "eventKey",
          ));
        }
      }

      checkpoint = page.nextCursor;
      checkpointFingerprint = providerMixedCursorFingerprint(checkpoint);
      if (checkpointFingerprint !== page.nextCursorFingerprint) {
        return refuse("COURTYARD_CENSUS_CURSOR_INVALID");
      }
      if (pageNumber % progressIntervalPages === 0) {
        console.log(JSON.stringify({
          event: "courtyard_source_census_progress",
          pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
          pages: pageNumber,
          sourceRecords,
          elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(1)),
        }));
      }
      if (page.continuation === "head") {
        completed = true;
        break;
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  if (!completed) return refuse("COURTYARD_CENSUS_PAGE_LIMIT_EXCEEDED");
  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  console.log(JSON.stringify({
    event: "courtyard_source_census_complete",
    pageLimit: DATAFORREST_LAUNCH_DISTRIBUTED_PAGE_TARGET_RECORDS,
    pageCount: completedPages,
    sourceRecords,
    mixedRecords,
    catalogRecordOccurrences,
    pullRecordOccurrences,
    marketEventRecordOccurrences,
    categories: identities.categories.size,
    packs: identities.packs.size,
    collectibles: identities.collectibles.size,
    pulls: identities.pulls.size,
    marketEvents: identities.marketEvents.size,
    quarantined: identities.quarantines.size,
    providerAccounts: 0,
    packContents: 0,
    maximumResponseBytes,
    elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
    sourceRecordsPerSecond: Number((sourceRecords / elapsedSeconds).toFixed(1)),
  }));
}

run().catch((error: unknown) => {
  const candidate = error instanceof Error ? error.message : "";
  const code = /^(?:COURTYARD_CENSUS|PROVIDER_DATAFORREST)_[A-Z0-9_]+$/u
      .test(candidate)
    ? candidate
    : "COURTYARD_CENSUS_FAILED";
  console.error(JSON.stringify({
    event: "courtyard_source_census_failed",
    code,
  }));
  process.exitCode = 1;
});
