import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSyntheticCatalogSnapshotV1,
  publicPackSummaryFromDetail,
} from "./__fixtures__/catalog-snapshot-v1.fixture.ts";
import {
  catalogSnapshotV1Schema,
  publicAvailabilityReasonSchema,
  publicPackLinkSchema,
  publicPackSummarySchema,
  publicPlatformConfigSchema,
  safeParseCatalogSnapshotV1,
} from "./catalog-snapshot-v1.ts";

function rejectionMessages(input: unknown): readonly string[] {
  const result = safeParseCatalogSnapshotV1(input);
  assert.equal(result.success, false);
  if (result.success) return [];
  return result.error.issues.map(({ message }) => message);
}

test("the synthetic CatalogSnapshotV1 fixture covers truthful public states", () => {
  const snapshot = buildSyntheticCatalogSnapshotV1();

  assert.equal(snapshot.metadata.dataSource, "canonical");
  assert.equal(snapshot.metadata.sourceWatermark, "catalog.42-pulls.17-trades.9");
  assert.equal(snapshot.metadata.publicConfigRevision, 6);
  assert.equal(snapshot.platformConfigs.length, 2);
  assert.equal(snapshot.packs.length, 3);
  assert.equal(snapshot.packs[0]?.estimatedEv.evDollars.status, "available");
  assert.equal(snapshot.packs[1]?.estimatedEv.evDollars.status, "unavailable");
  assert.equal(snapshot.packs[1]?.primaryImage, null);
  assert.equal(snapshot.packs[2]?.availability, "sold_out");
  assert.deepEqual(snapshot.packs[2]?.actions, {});

  const summary = publicPackSummaryFromDetail(snapshot.packs[0]!);
  assert.equal(publicPackSummarySchema.safeParse(summary).success, true);
  assert.equal("description" in summary, false);
  assert.equal("actions" in summary, false);
  assert.equal("coverage" in summary.estimatedEv, false);
  assert.equal("limitations" in summary.estimatedEv, false);
  assert.equal(
    summary.topChase.status === "available" &&
      "evidenceKind" in summary.topChase.value,
    false,
  );
});

test("materialized signed EV dollars and percent must match authoritative inputs", () => {
  const dollars = structuredClone(buildSyntheticCatalogSnapshotV1());
  const dollarsValue = dollars.packs[0]!.estimatedEv.evDollars;
  assert.equal(dollarsValue.status, "available");
  if (dollarsValue.status === "available") {
    dollarsValue.value.minorUnits -= 1;
  }
  assert.ok(rejectionMessages(dollars).includes("public_ev.dollars_inconsistent"));

  const percent = structuredClone(buildSyntheticCatalogSnapshotV1());
  const percentValue = percent.packs[0]!.estimatedEv.evPercent;
  assert.equal(percentValue.status, "available");
  if (percentValue.status === "available") {
    percentValue.value.basisPoints -= 1;
  }
  assert.ok(rejectionMessages(percent).includes("public_ev.percent_inconsistent"));
});

test("derived metric reasons use price, currency, then estimate precedence", () => {
  const missingPrice = structuredClone(buildSyntheticCatalogSnapshotV1());
  const pack = missingPrice.packs[0]!;
  pack.price = {
    displayMoney: null,
    usdComparison: {
      status: "unavailable",
      value: null,
      reason: "PRICE_UNAVAILABLE",
      nullRank: 1,
    },
  };
  pack.estimatedEv = {
    grossEv: {
      status: "unavailable",
      value: null,
      reason: "ESTIMATE_INPUT_INCOMPLETE",
      nullRank: 1,
    },
    grossReturn: {
      status: "unavailable",
      value: null,
      reason: "ESTIMATE_INPUT_INCOMPLETE",
      nullRank: 1,
    },
    evDollars: {
      status: "unavailable",
      value: null,
      reason: "PRICE_UNAVAILABLE",
      nullRank: 1,
    },
    evPercent: {
      status: "unavailable",
      value: null,
      reason: "PRICE_UNAVAILABLE",
      nullRank: 1,
    },
    calculatedAt: null,
    coverage: {
      evidenceCompleteness: "unknown",
      probabilityCoverageBasisPoints: null,
    },
    limitations: ["Price evidence is unavailable."],
  };
  assert.equal(catalogSnapshotV1Schema.safeParse(missingPrice).success, true);

  pack.estimatedEv.evDollars = {
    status: "unavailable",
    value: null,
    reason: "CURRENCY_UNSUPPORTED",
    nullRank: 1,
  };
  assert.ok(
    rejectionMessages(missingPrice).includes(
      "public_ev.reason_precedence_mismatch",
    ),
  );
});

test("money, reason codes, config revisions, and watermarks stay constrained", () => {
  const fractionalMoney = structuredClone(buildSyntheticCatalogSnapshotV1());
  const displayMoney = fractionalMoney.packs[0]!.price.displayMoney;
  assert.notEqual(displayMoney, null);
  if (displayMoney !== null) displayMoney.minorUnits = 1.5;
  assert.equal(safeParseCatalogSnapshotV1(fractionalMoney).success, false);

  const unknownReason = structuredClone(
    buildSyntheticCatalogSnapshotV1(),
  ) as unknown as {
    packs: Array<{ buyback: { reason: string } }>;
  };
  unknownReason.packs[1]!.buyback.reason = "PROVIDER_CALCULATOR_FAILED";
  assert.equal(safeParseCatalogSnapshotV1(unknownReason).success, false);
  assert.equal(
    publicAvailabilityReasonSchema.safeParse("PROVIDER_CALCULATOR_FAILED")
      .success,
    false,
  );

  const nonIntegerRevision = structuredClone(buildSyntheticCatalogSnapshotV1());
  nonIntegerRevision.metadata.publicConfigRevision = 6.5;
  assert.equal(safeParseCatalogSnapshotV1(nonIntegerRevision).success, false);

  const unsafeWatermark = structuredClone(buildSyntheticCatalogSnapshotV1());
  unsafeWatermark.metadata.sourceWatermark = "catalog cursor with spaces";
  assert.equal(safeParseCatalogSnapshotV1(unsafeWatermark).success, false);

  const unknownSource = structuredClone(
    buildSyntheticCatalogSnapshotV1(),
  ) as unknown as { metadata: { dataSource: string } };
  unknownSource.metadata.dataSource = "frontend_fixture";
  assert.equal(safeParseCatalogSnapshotV1(unknownSource).success, false);
});

test("public links and images are HTTPS, exact-host, and config-approved", () => {
  assert.equal(
    publicPackLinkSchema.safeParse({
      listingUrl: "https://user:secret@collector.example/packs/one",
      listingHost: "collector.example",
      referralParameters: [],
    }).success,
    false,
  );
  assert.equal(
    publicPackLinkSchema.safeParse({
      listingUrl: "http://collector.example/packs/one",
      listingHost: "collector.example",
      referralParameters: [],
    }).success,
    false,
  );
  assert.equal(
    publicPackLinkSchema.safeParse({
      listingUrl: "https://collector.example/packs/one",
      listingHost: "attacker.example",
      referralParameters: [],
    }).success,
    false,
  );

  const imageOrigin = structuredClone(buildSyntheticCatalogSnapshotV1());
  imageOrigin.packs[0]!.primaryImage!.url =
    "https://unapproved.example/packs/mythic.webp";
  assert.ok(
    rejectionMessages(imageOrigin).includes(
      "snapshot.pack_image_origin_not_approved",
    ),
  );

  const referral = structuredClone(buildSyntheticCatalogSnapshotV1());
  const link = referral.packs[0]!.actions.packLink;
  assert.notEqual(link, undefined);
  if (link !== undefined) link.referralParameters[0]!.value = "someone-else";
  assert.ok(
    rejectionMessages(referral).includes("snapshot.pack_link_not_approved"),
  );
});

test("sold-out packs cannot publish a Pack Link", () => {
  const snapshot = structuredClone(buildSyntheticCatalogSnapshotV1());
  const soldOut = snapshot.packs[2]!;
  soldOut.actionAvailability.packLink = true;
  soldOut.actions.packLink = {
    listingUrl: "https://courtyard.example/packs/master",
    listingHost: "courtyard.example",
    referralParameters: [{ name: "utm_source", value: "packscout" }],
  };

  const messages = rejectionMessages(snapshot);
  assert.ok(messages.includes("public_pack.sold_out_actionable"));
});

test("snapshot counts, ordering, facets, and config identity reconcile", () => {
  const count = structuredClone(buildSyntheticCatalogSnapshotV1());
  count.metadata.packCount += 1;
  assert.ok(rejectionMessages(count).includes("snapshot.pack_count_mismatch"));

  const order = structuredClone(buildSyntheticCatalogSnapshotV1());
  [order.packs[0], order.packs[1]] = [order.packs[1]!, order.packs[0]!];
  assert.ok(
    rejectionMessages(order).includes("snapshot.packs_not_canonical"),
  );

  const facet = structuredClone(buildSyntheticCatalogSnapshotV1());
  facet.facets.platforms[0]!.packCount = 2;
  assert.ok(
    rejectionMessages(facet).includes("snapshot.platform_facet_mismatch"),
  );

  const identity = structuredClone(buildSyntheticCatalogSnapshotV1());
  identity.packs[0]!.platformDisplayName = "Unapproved Partner Name";
  assert.ok(
    rejectionMessages(identity).includes(
      "snapshot.pack_config_identity_mismatch",
    ),
  );
});

test("strict schemas and fixtures expose no protected pipeline fields", () => {
  const snapshot = buildSyntheticCatalogSnapshotV1();
  const forbidden = structuredClone(snapshot) as unknown as Record<
    string,
    unknown
  >;
  forbidden.organizationId = "internal-organization";
  assert.equal(safeParseCatalogSnapshotV1(forbidden).success, false);

  const sensitiveKeys: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "data" ||
        /^(?:organization|tenant|actor|run|wallet|username|credential|quarantine|provider)(?:_|[A-Z]|$)/.test(
          key,
        )
      ) {
        sensitiveKeys.push(key);
      }
      visit(child);
    }
  };
  visit(snapshot);
  assert.deepEqual(sensitiveKeys, []);

  const config = structuredClone(snapshot.platformConfigs[0]!);
  const configWithSecret = {
    ...config,
    approvalActor: "internal-actor",
  };
  assert.equal(publicPlatformConfigSchema.safeParse(configWithSecret).success, false);
});
