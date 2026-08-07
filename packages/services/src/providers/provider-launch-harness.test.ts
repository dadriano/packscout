import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  safeValidateProviderFeedPageV1,
  type CatalogEnvelopeV1,
  type ProviderFeedPageStructureV1,
  type ProviderFeedPageV1,
} from "@packscout/contracts";
import { CatalogProjectionService } from "../catalog-projection-service.ts";
import { calculatePackScoutEstimatedEv } from "../estimated-ev-calculator.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../event-projection-service.ts";
import { HttpCursorAdapter } from "../http-cursor-adapter.ts";
import { DefaultProviderImportPagePlanner } from "../provider-import-page-planner.ts";
import type {
  ProviderAdapterCandidate,
  ProviderConfigurationIdentity,
  ProviderMappingAdapter,
  NormalizedProviderTransportFailure,
} from "../provider-adapter.ts";
import { ProviderTransportRequestError } from "../provider-adapter.ts";
import { ProviderProjectionService } from "../provider-projection-service.ts";
import type {
  ProviderCanonicalProjectionCommand,
  ProviderImportMappedPage,
} from "../provider-import-types.ts";
import {
  createProviderMappingAdapterRegistryFromManifest,
  providerMapperManifest,
  type ProviderMapperManifestEntry,
} from "./provider-mapper-manifest.ts";

const sampleRoot =
  process.env.PACKSCOUT_PROVIDER_SAMPLES ??
  join(homedir(), "Documents", "packscout-data");
const calculatedAt = "2026-08-06T12:00:00.000Z";

interface CommitEvidence {
  readonly accepted: number;
  readonly quarantined: number;
  readonly replayed: number;
  readonly corrected: number;
  readonly newRecords: number;
  readonly canonicalCreated: number;
  readonly canonicalRevised: number;
  readonly canonicalUnchanged: number;
}

interface LaunchEvidence {
  readonly platformKey: string;
  readonly rawRecords: number;
  readonly mappedRecords: number;
  readonly projectionCommands: number;
  readonly initialCanonicalRecords: number;
  readonly canonicalRecords: number;
  readonly backfill: CommitEvidence;
  readonly incremental: CommitEvidence;
  readonly evEstimated: number;
  readonly evUnavailable: number;
  readonly unavailableReasons: readonly string[];
  readonly malformedQuarantined: number;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)))
    .digest("hex");
}

function sourceIdentity(record: ProviderImportMappedPage["records"][number]): string {
  return `${record.recordKind}:${record.externalId}`;
}

function sourceVersion(record: ProviderImportMappedPage["records"][number]): string {
  return `${sourceIdentity(record)}:${record.sourceTime.toISOString()}:${fingerprint(record.payload)}`;
}

function canonicalIdentity(command: ProviderCanonicalProjectionCommand): string {
  return `${command.platformKey}:${command.recordKind}:${command.externalId}`;
}

function assertSafeCanonicalProjection(
  command: ProviderCanonicalProjectionCommand,
): void {
  assert.doesNotMatch(
    JSON.stringify(command),
    /"(?:username|wallet|fromUsername|toUsername|ownerAddress)"\s*:/i,
  );
  if (command.recordKind !== "pull" && command.recordKind !== "sale") return;
  const actorKeys = command.content.actorKeys;
  assert.equal(typeof actorKeys, "object");
  assert.notEqual(actorKeys, null);
  for (const actorKey of Object.values(actorKeys as Record<string, unknown>)) {
    assert.equal(typeof actorKey, "string");
    assert.match(actorKey as string, /^actor:v1:[a-f0-9]{64}$/);
  }
}

class DurableLaunchLedger {
  cursor: string | null = null;
  readonly sourceVersions = new Set<string>();
  readonly sourceIdentities = new Set<string>();
  readonly canonical = new Map<string, string>();

  commit(page: ProviderImportMappedPage): CommitEvidence {
    const evidence = {
      accepted: 0,
      quarantined: page.quarantines.length,
      replayed: 0,
      corrected: 0,
      newRecords: page.quarantines.length,
      canonicalCreated: 0,
      canonicalRevised: 0,
      canonicalUnchanged: 0,
    };
    for (const record of page.records) {
      const version = sourceVersion(record);
      if (this.sourceVersions.has(version)) {
        evidence.replayed += 1;
        continue;
      }
      const identity = sourceIdentity(record);
      if (this.sourceIdentities.has(identity)) evidence.corrected += 1;
      else evidence.newRecords += 1;
      this.sourceVersions.add(version);
      this.sourceIdentities.add(identity);
      if (record.quarantine) {
        evidence.quarantined += 1;
        continue;
      }
      evidence.accepted += 1;
      for (const command of record.projections) {
        assertSafeCanonicalProjection(command);
        const identityKey = canonicalIdentity(command);
        const next = fingerprint(command);
        const current = this.canonical.get(identityKey);
        if (!current) evidence.canonicalCreated += 1;
        else if (current === next) evidence.canonicalUnchanged += 1;
        else evidence.canonicalRevised += 1;
        this.canonical.set(identityKey, next);
      }
    }
    return evidence;
  }
}

class ControllableCursorEndpoint {
  readonly requestedCursors: (string | null)[] = [];

  fetch(cursor: string | null, page: ProviderFeedPageStructureV1) {
    this.requestedCursors.push(cursor);
    return structuredClone(page);
  }
}

class ControllableCursorLaunchHarness {
  constructor(
    private readonly ledger: DurableLaunchLedger,
    private readonly endpoint: ControllableCursorEndpoint,
    private readonly planner: DefaultProviderImportPagePlanner,
  ) {}

  async importPage(
    configuration: ProviderConfigurationIdentity,
    page: ProviderFeedPageStructureV1,
  ): Promise<CommitEvidence> {
    const requestedCursor = this.ledger.cursor;
    const rawPage = this.endpoint.fetch(requestedCursor, page);
    const parsed = safeValidateProviderFeedPageV1(rawPage, {
      requestedPlatform: configuration.platform,
      requestedCursor,
      seenCursors: requestedCursor ? new Set([requestedCursor]) : new Set(),
    });
    if (!parsed.success) throw parsed.error;
    const planned = await this.planner.plan({
      configuration,
      page: parsed.data,
    });
    const committed = this.ledger.commit(planned);
    this.ledger.cursor = parsed.data.rawPage.next_cursor;
    return committed;
  }
}

function loadSample(entry: ProviderMapperManifestEntry): ProviderFeedPageV1 {
  const path = join(sampleRoot, `${entry.platformKey}.json`);
  const bytes = readFileSync(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    entry.sourceContract.sha256,
    `${entry.platformKey} fixture hash changed without a manifest revision`,
  );
  const source = JSON.parse(bytes.toString("utf8")) as Omit<
    ProviderFeedPageV1,
    "has_more" | "next_cursor"
  >;
  return {
    ...source,
    next_cursor: `fixture:${entry.platformKey}:head:v1`,
    has_more: false,
  };
}

function configuration(entry: ProviderMapperManifestEntry): ProviderConfigurationIdentity {
  return {
    providerId: `fixture-provider-${entry.platformKey}`,
    configurationRevisionId: `fixture-revision-${entry.platformKey}`,
    platform: entry.platformKey,
    adapterKey: entry.adapterKey,
  };
}

function recordIndexes(page: ProviderFeedPageV1) {
  return {
    catalog: page.catalog.map((_, index) => index),
    pulls: page.pulls.map((_, index) => index),
    sales: page.sales.map((_, index) => index),
  };
}

async function mappedCandidates(
  adapter: ProviderMappingAdapter,
  page: ProviderFeedPageV1,
): Promise<readonly ProviderAdapterCandidate[]> {
  const output = await adapter.mapPage({
    configuration: configuration(
      providerMapperManifest.find(({ adapter: candidate }) => candidate === adapter)!,
    ),
    page,
    recordIndexes: recordIndexes(page),
  });
  return output.outcomes.flatMap((outcome) =>
    outcome.status === "mapped" ? outcome.candidates : [],
  );
}

async function evEvidence(entry: ProviderMapperManifestEntry, page: ProviderFeedPageV1) {
  const candidates = await mappedCandidates(entry.adapter, page);
  let estimated = 0;
  let unavailable = 0;
  const reasons = new Set<string>();
  for (const evInput of candidates.filter(
    (candidate) => candidate.candidateKind === "ev_input",
  )) {
    if (evInput.candidateKind !== "ev_input") continue;
    const pack = candidates.find(
      (candidate) =>
        candidate.candidateKind === "pack" &&
        candidate.externalId === evInput.packExternalId,
    );
    if (!pack || pack.candidateKind !== "pack") continue;
    const result = calculatePackScoutEstimatedEv({
      packPrice: pack.price
        ? {
            valueMinor: Math.round(pack.price.amount * 100),
            currency: pack.price.currency,
            sourceRevisionId: "fixture-pack-revision",
          }
        : null,
      distributionCurrency: evInput.currency,
      unitBasis: evInput.unitBasis,
      drawCount: evInput.drawCount,
      declaredCoverage: evInput.declaredCoverage,
      evidenceCompleteness: evInput.evidenceCompleteness,
      buckets: evInput.buckets
        .filter(({ evidenceKind }) => evidenceKind === "probability_bucket")
        .map((bucket) => ({
          probability: bucket.probability,
          lowerValueMinor:
            bucket.lowerValue === null
              ? null
              : Math.round(bucket.lowerValue * 100),
          upperValueMinor:
            bucket.upperValue === null
              ? null
              : Math.round(bucket.upperValue * 100),
          sourceRevisionId: "fixture-ev-input-revision",
        })),
      sourceAt: evInput.source.sourceTimestamp,
      calculatedAt,
      currencyPolicy: { verifiedUsdStablecoins: ["USDC"] },
    });
    if (result.status === "estimated") estimated += 1;
    else {
      unavailable += 1;
      result.reasonCodes.forEach((reason) => reasons.add(reason));
    }
  }
  return {
    estimated,
    unavailable,
    reasons: [...reasons].sort(),
  };
}

function advanceTimestamp(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function incrementalPage(page: ProviderFeedPageV1): ProviderFeedPageV1 {
  const original = page.pulls[0];
  assert.ok(original);
  const replay = structuredClone(original);
  const correction = structuredClone(original);
  correction.occurred_at = advanceTimestamp(original.occurred_at, 1_000);
  correction.collected_at = advanceTimestamp(original.collected_at, 1_000);
  const added = structuredClone(original);
  added.external_id = `${original.external_id}:fixture-new`;
  added.occurred_at = advanceTimestamp(original.occurred_at, 2_000);
  added.collected_at = advanceTimestamp(original.collected_at, 2_000);
  return {
    catalog: [],
    pulls: [replay, correction, added],
    sales: [],
    next_cursor: page.next_cursor.replace("v1", "v2"),
    has_more: false,
  };
}

function malformedPage(page: ProviderFeedPageV1): ProviderFeedPageStructureV1 {
  const original = page.catalog[0];
  assert.ok(original);
  const malformed = structuredClone(original) as CatalogEnvelopeV1;
  malformed.external_id = `${original.external_id}:fixture-malformed`;
  malformed.updated_at = "invalid-fixture-time";
  return {
    catalog: [structuredClone(original), malformed],
    pulls: [],
    sales: [],
    next_cursor: page.next_cursor.replace("v1", "v3"),
    has_more: false,
  };
}

const allSamplesAvailable = providerMapperManifest.every((entry) =>
  existsSync(join(sampleRoot, `${entry.platformKey}.json`)),
);

test(
  "all manifest platforms pass the non-importing HTTP cursor connection gate",
  { skip: !allSamplesAvailable },
  async () => {
    for (const entry of providerMapperManifest) {
      const page = loadSample(entry);
      let requestedPlatform: string | null = null;
      let requestedCursor: string | null = "not-requested";
      const adapter = new HttpCursorAdapter({
        resolveHost: async () => ["93.184.216.34"],
        httpClient: async (input) => {
          const url = new URL(String(input));
          requestedPlatform = url.searchParams.get("platform");
          requestedCursor = url.searchParams.get("cursor");
          return new Response(JSON.stringify(page), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const result = await adapter.testConnection({
        endpoint: "https://provider.invalid/feed?cursor=must-be-removed",
        allowedHosts: ["provider.invalid"],
        platform: entry.platformKey,
        auth: { mode: "none" },
      });
      assert.equal(requestedPlatform, entry.platformKey);
      assert.equal(requestedCursor, null);
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.deepEqual(
        result.recordCounts,
        {
          catalog: entry.sourceContract.observedRecordCounts.catalog,
          pulls: entry.sourceContract.observedRecordCounts.pull,
          sales: entry.sourceContract.observedRecordCounts.sale,
        },
      );
      assert.equal(result.nextCursorPresent, true);
    }
  },
);

test(
  "all manifest platforms reconcile fixture backfill and durable-head incremental evidence",
  { skip: !allSamplesAvailable },
  async () => {
    const planner = new DefaultProviderImportPagePlanner(
      createProviderMappingAdapterRegistryFromManifest(),
      new ProviderProjectionService(
        new CatalogProjectionService(),
        new EventProjectionService(
          new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(12)),
        ),
      ),
    );
    const evidence: LaunchEvidence[] = [];

    for (const entry of providerMapperManifest) {
      const page = loadSample(entry);
      const ledger = new DurableLaunchLedger();
      const endpoint = new ControllableCursorEndpoint();
      const backfillHarness = new ControllableCursorLaunchHarness(
        ledger,
        endpoint,
        planner,
      );
      const initial = await backfillHarness.importPage(configuration(entry), page);
      assert.equal(endpoint.requestedCursors[0], null);
      assert.equal(initial.replayed, 0);
      assert.equal(initial.quarantined, 0);
      assert.equal(
        initial.accepted,
        Object.values(entry.sourceContract.observedRecordCounts).reduce(
          (total, count) => total + count,
          0,
        ),
      );
      const initialCanonicalRecords = ledger.canonical.size;

      // Reconstructing the runner around the same durable ledger simulates a
      // process restart; the next request must still begin at the committed head.
      const incrementalHarness = new ControllableCursorLaunchHarness(
        ledger,
        endpoint,
        planner,
      );
      const incremental = await incrementalHarness.importPage(
        configuration(entry),
        incrementalPage(page),
      );
      assert.deepEqual(
        { replayed: incremental.replayed, corrected: incremental.corrected, new: incremental.newRecords },
        { replayed: 1, corrected: 1, new: 1 },
      );
      assert.equal(endpoint.requestedCursors[1], page.next_cursor);

      const malformed = await incrementalHarness.importPage(
        configuration(entry),
        malformedPage(page),
      );
      assert.equal(malformed.quarantined, 1);
      assert.equal(malformed.replayed, 1);

      const nonAdvancing = safeValidateProviderFeedPageV1(
        {
          catalog: [structuredClone(page.catalog[0]!)],
          pulls: [],
          sales: [],
          next_cursor: ledger.cursor,
          has_more: true,
        },
        {
          requestedPlatform: entry.platformKey,
          requestedCursor: ledger.cursor,
          seenCursors: new Set(ledger.cursor ? [ledger.cursor] : []),
        },
      );
      assert.equal(nonAdvancing.success, false);
      if (!nonAdvancing.success) {
        assert.deepEqual(nonAdvancing.error.issues, [
          { code: "cursor_not_advanced", path: "next_cursor" },
        ]);
      }

      const ev = await evEvidence(entry, page);
      const candidates = await mappedCandidates(entry.adapter, page);
      assert.equal(
        initial.canonicalCreated +
          initial.canonicalRevised +
          initial.canonicalUnchanged,
        candidates.length,
      );
      evidence.push({
        platformKey: entry.platformKey,
        rawRecords: initial.accepted,
        mappedRecords: initial.accepted,
        projectionCommands: candidates.length,
        initialCanonicalRecords,
        canonicalRecords: ledger.canonical.size,
        backfill: initial,
        incremental,
        evEstimated: ev.estimated,
        evUnavailable: ev.unavailable,
        unavailableReasons: ev.reasons,
        malformedQuarantined: malformed.quarantined,
      });
    }

    assert.deepEqual(
      evidence.map(
        ({
          platformKey,
          rawRecords,
          mappedRecords,
          projectionCommands,
          initialCanonicalRecords,
          canonicalRecords,
          backfill,
          evEstimated,
          evUnavailable,
          unavailableReasons,
        }) => ({
          platformKey,
          rawRecords,
          mappedRecords,
          projectionCommands,
          initialCanonicalRecords,
          canonicalRecords,
          backfillCanonical: [
            backfill.canonicalCreated,
            backfill.canonicalRevised,
            backfill.canonicalUnchanged,
          ],
          evEstimated,
          evUnavailable,
          unavailableReasons,
        }),
      ),
      [
        {
          platformKey: "beezie",
          rawRecords: 34,
          mappedRecords: 34,
          projectionCommands: 257,
          initialCanonicalRecords: 257,
          canonicalRecords: 258,
          backfillCanonical: [257, 0, 0],
          evEstimated: 4,
          evUnavailable: 0,
          unavailableReasons: [],
        },
        {
          platformKey: "clutchpacks",
          rawRecords: 44,
          mappedRecords: 44,
          projectionCommands: 1_206,
          initialCanonicalRecords: 951,
          canonicalRecords: 952,
          backfillCanonical: [951, 255, 0],
          evEstimated: 6,
          evUnavailable: 8,
          unavailableReasons: [
            "incomplete_inventory",
            "incomplete_probability_coverage",
          ],
        },
        {
          platformKey: "collector_crypt",
          rawRecords: 44,
          mappedRecords: 44,
          projectionCommands: 331,
          initialCanonicalRecords: 288,
          canonicalRecords: 289,
          backfillCanonical: [288, 43, 0],
          evEstimated: 7,
          evUnavailable: 0,
          unavailableReasons: [],
        },
        {
          platformKey: "courtyard",
          rawRecords: 41,
          mappedRecords: 41,
          projectionCommands: 299,
          initialCanonicalRecords: 285,
          canonicalRecords: 286,
          backfillCanonical: [285, 14, 0],
          evEstimated: 4,
          evUnavailable: 4,
          unavailableReasons: [
            "incomplete_inventory",
            "missing_probability_buckets",
          ],
        },
        {
          platformKey: "gamestop",
          rawRecords: 23,
          mappedRecords: 23,
          projectionCommands: 1_213,
          initialCanonicalRecords: 1_213,
          canonicalRecords: 1_214,
          backfillCanonical: [1_213, 0, 0],
          evEstimated: 35,
          evUnavailable: 10,
          unavailableReasons: ["incomplete_probability_coverage"],
        },
        {
          platformKey: "phygitals",
          rawRecords: 45,
          mappedRecords: 45,
          projectionCommands: 526,
          initialCanonicalRecords: 524,
          canonicalRecords: 525,
          backfillCanonical: [524, 2, 0],
          evEstimated: 0,
          evUnavailable: 18,
          unavailableReasons: [
            "ambiguous_unit_basis",
            "incomplete_inventory",
            "incomplete_probability_coverage",
            "invalid_draw_count",
          ],
        },
        {
          platformKey: "stadium_vault",
          rawRecords: 29,
          mappedRecords: 29,
          projectionCommands: 211,
          initialCanonicalRecords: 147,
          canonicalRecords: 148,
          backfillCanonical: [147, 64, 0],
          evEstimated: 14,
          evUnavailable: 0,
          unavailableReasons: [],
        },
        {
          platformKey: "trove",
          rawRecords: 30,
          mappedRecords: 30,
          projectionCommands: 225,
          initialCanonicalRecords: 210,
          canonicalRecords: 211,
          backfillCanonical: [210, 15, 0],
          evEstimated: 15,
          evUnavailable: 0,
          unavailableReasons: [],
        },
      ],
    );
    assert.equal(evidence.reduce((total, row) => total + row.rawRecords, 0), 290);
    assert.equal(
      evidence.reduce((total, row) => total + row.projectionCommands, 0),
      4_268,
    );
    assert.equal(evidence.every(({ malformedQuarantined }) => malformedQuarantined === 1), true);
  },
);

type ControllableTransportStep =
  | { readonly kind: "failure"; readonly failure: NormalizedProviderTransportFailure }
  | { readonly kind: "page"; readonly page: ProviderFeedPageStructureV1 };

class ControllableFailureEndpoint {
  attempts = 0;

  constructor(private readonly steps: readonly ControllableTransportStep[]) {}

  fetch(): ProviderFeedPageStructureV1 {
    const step = this.steps[this.attempts];
    this.attempts += 1;
    assert.ok(step, "mock transport exhausted before a terminal outcome");
    if (step.kind === "failure") {
      throw new ProviderTransportRequestError(step.failure);
    }
    return structuredClone(step.page);
  }
}

function fetchWithMockRecovery(
  endpoint: ControllableFailureEndpoint,
  platform: string,
  requestedCursor: string,
) {
  const maximumTransientRetries = 2;
  for (let retry = 0; retry <= maximumTransientRetries; retry += 1) {
    try {
      const result = safeValidateProviderFeedPageV1(endpoint.fetch(), {
        requestedPlatform: platform,
        requestedCursor,
        seenCursors: new Set([requestedCursor]),
      });
      assert.equal(result.success, true);
      return {
        state: retry === 0 ? "succeeded" : "recovered",
        attempts: endpoint.attempts,
        failureCode: null,
      } as const;
    } catch (error) {
      assert.ok(error instanceof ProviderTransportRequestError);
      if (!error.failure.retryable || retry === maximumTransientRetries) {
        return {
          state: "failed",
          attempts: endpoint.attempts,
          failureCode: error.failure.code,
        } as const;
      }
    }
  }
  throw new Error("unreachable mock recovery state");
}

test("representative mock transport outcomes recover or fail closed without platform branches", () => {
  const cursor = "fixture:durable-head";
  const successPage = (platformKey: string): ProviderFeedPageStructureV1 => ({
    catalog: [],
    pulls: [],
    sales: [],
    next_cursor: `${cursor}:${platformKey}:next`,
    has_more: false,
  });
  const scenarios = [
    {
      name: "rate_limited_then_recovered",
      steps: (platformKey: string): readonly ControllableTransportStep[] => [
        {
          kind: "failure",
          failure: { code: "http_error", retryable: true, httpStatus: 429 },
        },
        { kind: "page", page: successPage(platformKey) },
      ],
      expected: { state: "recovered", attempts: 2, failureCode: null },
    },
    {
      name: "timeout_then_recovered",
      steps: (platformKey: string): readonly ControllableTransportStep[] => [
        { kind: "failure", failure: { code: "timeout", retryable: true } },
        { kind: "page", page: successPage(platformKey) },
      ],
      expected: { state: "recovered", attempts: 2, failureCode: null },
    },
    {
      name: "authentication_failed",
      steps: (): readonly ControllableTransportStep[] => [
        {
          kind: "failure",
          failure: { code: "http_error", retryable: false, httpStatus: 401 },
        },
      ],
      expected: { state: "failed", attempts: 1, failureCode: "http_error" },
    },
    {
      name: "cursor_safety_failed",
      steps: (): readonly ControllableTransportStep[] => [
        {
          kind: "failure",
          failure: {
            code: "invalid_response",
            retryable: false,
            issueCodes: ["cursor_not_advanced"],
          },
        },
      ],
      expected: {
        state: "failed",
        attempts: 1,
        failureCode: "invalid_response",
      },
    },
  ] as const;

  const evidence = [];
  for (const entry of providerMapperManifest) {
    for (const scenario of scenarios) {
      const endpoint = new ControllableFailureEndpoint(
        scenario.steps(entry.platformKey),
      );
      const actual = fetchWithMockRecovery(endpoint, entry.platformKey, cursor);
      assert.deepEqual(actual, scenario.expected);
      evidence.push({
        platformKey: entry.platformKey,
        scenario: scenario.name,
        ...actual,
      });
    }
  }
  assert.equal(evidence.length, providerMapperManifest.length * scenarios.length);
  assert.equal(evidence.filter(({ state }) => state === "recovered").length, 16);
  assert.equal(evidence.filter(({ state }) => state === "failed").length, 16);
});
