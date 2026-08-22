import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildSanitizedProviderFeedFixtures } from "./__fixtures__/provider-feed.fixtures.ts";
import {
  parseProviderFeedPageV1,
  safeParseProviderFeedPageV1,
  safeValidateProviderFeedPageV1,
  type ProviderFeedValidationContext,
  type ProviderFeedValidationIssue,
} from "./provider-feed.ts";

interface SampleManifestEntry {
  readonly name: string;
  readonly file: string;
  readonly counts: { readonly catalog: number; readonly pulls: number; readonly trades: number };
  readonly nullableFields: {
    readonly pullPackExternalId: boolean;
    readonly tradeAmount: boolean;
    readonly tradeCurrency: boolean;
  };
}

interface SampleManifest {
  readonly outerStructure: {
    readonly pageKeySets: readonly (readonly string[])[];
    readonly recordKeySets: Readonly<
      Record<"catalog" | "pulls" | "trades", readonly (readonly string[])[]>
    >;
  };
  readonly samples: readonly SampleManifestEntry[];
}

const manifest = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/provider-sample-manifest.json", import.meta.url),
    "utf8",
  ),
) as SampleManifest;
const fixtures = buildSanitizedProviderFeedFixtures();
const baseFixture = fixtures[0];
if (!baseFixture) throw new Error("Expected at least one provider fixture.");

function expectIssues(
  input: unknown,
  context: ProviderFeedValidationContext,
  expected: readonly ProviderFeedValidationIssue[],
): void {
  const result = safeParseProviderFeedPageV1(input, context);
  assert.equal(result.success, false);
  if (result.success) assert.fail("Expected provider feed validation to fail.");
  assert.deepEqual(result.error.issues, expected);
  assert.equal(result.error.message, "Provider feed validation failed.");
}

test("sanitized fixtures align with the committed eight-sample manifest", () => {
  assert.deepEqual(manifest.outerStructure, {
    pageKeySets: [["catalog", "pulls", "trades"]],
    recordKeySets: {
      catalog: [["collected_at", "data", "external_id", "platform", "updated_at"]],
      pulls: [[
        "collected_at",
        "data",
        "external_id",
        "occurred_at",
        "pack_external_id",
        "platform",
      ]],
      trades: [[
        "amount",
        "collected_at",
        "currency",
        "data",
        "event_type",
        "external_id",
        "occurred_at",
        "platform",
        "tx_hash",
      ]],
    },
  });
  assert.deepEqual(
    fixtures.map(({ name }) => name),
    manifest.samples.map(({ name }) => name),
  );

  for (const fixture of fixtures) {
    const sample = manifest.samples.find(({ name }) => name === fixture.name);
    assert.ok(sample);
    assert.deepEqual(fixture.sampleProfile, {
      file: sample.file,
      counts: sample.counts,
      nullableFields: sample.nullableFields,
    });
    const parsed = parseProviderFeedPageV1(fixture.page, {
      requestedPlatform: fixture.name,
    });
    assert.equal(parsed.catalog[0]?.platform, fixture.name);
    assert.equal(typeof parsed.catalog[0]?.data.fixture_shape, "string");
    assert.equal(parsed.trades.length === 0, sample.counts.trades === 0);
    assert.equal(
      parsed.pulls.some(({ pack_external_id }) => pack_external_id === null),
      sample.nullableFields.pullPackExternalId,
    );
    assert.equal(
      parsed.trades.some(({ amount }) => amount === null),
      sample.nullableFields.tradeAmount,
    );
    assert.equal(
      parsed.trades.some(({ currency }) => currency === null),
      sample.nullableFields.tradeCurrency,
    );
  }
});

test("a trustworthy mixed page preserves raw evidence and quarantines only invalid records", () => {
  const invalidCatalog = { ...baseFixture.page.catalog[0], external_id: "" };
  const invalidPull = { ...baseFixture.page.pulls[0], data: [] };
  const mixedPage = {
    ...baseFixture.page,
    catalog: [baseFixture.page.catalog[0], invalidCatalog],
    pulls: [baseFixture.page.pulls[0], invalidPull],
    trades: [baseFixture.page.trades[0], "not-an-object"],
    next_cursor: "cursor-after-mixed-page",
    has_more: true,
  };
  const result = safeValidateProviderFeedPageV1(mixedPage, {
    requestedPlatform: baseFixture.name,
    requestedCursor: "cursor-before-mixed-page",
  });
  assert.equal(result.success, true);
  if (!result.success) assert.fail("Expected the page structure to remain trustworthy.");
  assert.equal(result.data.rawPage.catalog.length, 2);
  assert.equal(result.data.rawPage.pulls.length, 2);
  assert.equal(result.data.rawPage.trades.length, 2);
  assert.deepEqual(result.data.rawPage.catalog[1], invalidCatalog);
  assert.deepEqual(result.data.rawPage.pulls[1], invalidPull);
  assert.equal(result.data.validPage.catalog.length, 1);
  assert.equal(result.data.validPage.pulls.length, 1);
  assert.equal(result.data.validPage.next_cursor, "cursor-after-mixed-page");
  assert.deepEqual(
    result.data.invalidRecords.map(({ recordKind, recordIndex, issues }) => ({
      recordKind,
      recordIndex,
      issues,
    })),
    [
      {
        recordKind: "catalog",
        recordIndex: 1,
        issues: [{ code: "empty_string", path: "catalog[1].external_id" }],
      },
      {
        recordKind: "pull",
        recordIndex: 1,
        issues: [{ code: "invalid_type", path: "pulls[1].data" }],
      },
      {
        recordKind: "trade",
        recordIndex: 1,
        issues: [{ code: "invalid_type", path: "trades[1]" }],
      },
    ],
  );
  assert.deepEqual(
    result.data.recordOutcomes.map(({ status }) => status),
    ["valid", "invalid", "valid", "invalid", "valid", "invalid"],
  );

  expectIssues(
    mixedPage,
    {
      requestedPlatform: baseFixture.name,
      requestedCursor: "cursor-before-mixed-page",
    },
    [
      { code: "empty_string", path: "catalog[1].external_id" },
      { code: "invalid_type", path: "pulls[1].data" },
      { code: "invalid_type", path: "trades[1]" },
    ],
  );
});

test("missing arrays fail page trust while invalid records get stable paths", () => {
  const missingTrades: Record<string, unknown> = { ...baseFixture.page };
  delete missingTrades.trades;
  expectIssues(
    missingTrades,
    { requestedPlatform: baseFixture.name },
    [{ code: "invalid_type", path: "trades" }],
  );
  expectIssues(
    {
      ...baseFixture.page,
      catalog: [{ ...baseFixture.page.catalog[0], data: [] }],
    },
    { requestedPlatform: baseFixture.name },
    [{ code: "invalid_type", path: "catalog[0].data" }],
  );
});

test("malformed timestamps and non-finite amounts fail at their fields", () => {
  expectIssues(
    {
      ...baseFixture.page,
      pulls: [{ ...baseFixture.page.pulls[0], occurred_at: "not-an-instant" }],
    },
    { requestedPlatform: baseFixture.name },
    [{ code: "invalid_timestamp", path: "pulls[0].occurred_at" }],
  );
  expectIssues(
    {
      ...baseFixture.page,
      trades: [
        {
          ...fixtures.find(({ name }) => name === "beezie")?.page.trades[0],
          amount: Number.POSITIVE_INFINITY,
        },
      ],
    },
    { requestedPlatform: baseFixture.name },
    [{ code: "invalid_number", path: "trades[0].amount" }],
  );
});

test("every envelope platform must exactly match the requested platform", () => {
  expectIssues(
    {
      ...baseFixture.page,
      catalog: [
        { ...baseFixture.page.catalog[0], platform: "different-platform" },
      ],
    },
    { requestedPlatform: baseFixture.name },
    [{ code: "platform_mismatch", path: "catalog[0].platform" }],
  );
});

test("continuing pages must contain records and advance to an unseen cursor", () => {
  expectIssues(
    {
      catalog: [],
      pulls: [],
      trades: [],
      next_cursor: "cursor-2",
      has_more: true,
    },
    { requestedPlatform: baseFixture.name, requestedCursor: "cursor-1" },
    [{ code: "empty_continuing_page", path: "has_more" }],
  );
  expectIssues(
    { ...baseFixture.page, next_cursor: "cursor-1", has_more: true },
    { requestedPlatform: baseFixture.name, requestedCursor: "cursor-1" },
    [{ code: "cursor_not_advanced", path: "next_cursor" }],
  );
  expectIssues(
    { ...baseFixture.page, next_cursor: "cursor-seen", has_more: true },
    {
      requestedPlatform: baseFixture.name,
      requestedCursor: "cursor-current",
      seenCursors: new Set(["cursor-seen"]),
    },
    [{ code: "cursor_cycle", path: "next_cursor" }],
  );
});

test("accepted cursors are opaque, non-empty strings", () => {
  expectIssues(
    { ...baseFixture.page, next_cursor: "" },
    { requestedPlatform: baseFixture.name },
    [{ code: "empty_string", path: "next_cursor" }],
  );
  const opaqueCursor = "opaque/+?&=% cursor \u96ea";
  const parsed = parseProviderFeedPageV1(
    { ...baseFixture.page, next_cursor: opaqueCursor },
    { requestedPlatform: baseFixture.name },
  );
  assert.equal(parsed.next_cursor, opaqueCursor);
});
