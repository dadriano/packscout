import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixtureConfiguration,
  fixtureIds,
  fixtureSnapshot,
} from "./catalog-release-fixture.test-support.ts";
import { projectCatalogRelease } from "./catalog-release-public-projection.ts";

function project(snapshot = fixtureSnapshot()) {
  assert.ok(snapshot.configuration);
  return projectCatalogRelease({
    configuration: snapshot.configuration.configuration,
    activePlatformKeys: new Set(["alpha", "beta"]),
    revisions: snapshot.revisions,
    repackIdentities: snapshot.repackIdentities,
  });
}

test("aggregate repack categories use the exact governed union for focused and mixed chases", () => {
  const focused = project();
  assert.deepEqual(
    focused.repacks.find(({ publicRepackId }) =>
      publicRepackId === fixtureIds.alphaRepack)?.categories.map(
      ({ publicCategoryId }) => publicCategoryId,
    ),
    [fixtureIds.rootCategory, fixtureIds.childCategory],
  );

  const tradingCardGamesId = "13333333-3333-5333-8333-333333333333";
  const marvelId = "14444444-4444-5444-8444-444444444444";
  const allCategoryIds = [
    fixtureIds.rootCategory,
    fixtureIds.childCategory,
    tradingCardGamesId,
    marvelId,
  ];
  const configuration = {
    ...fixtureConfiguration,
    categories: [
      ...fixtureConfiguration.categories,
      {
        publicCategoryId: tradingCardGamesId,
        parentPublicCategoryId: null,
        categoryKey: "trading-card-games",
        name: "Trading card games",
        kind: "vertical" as const,
        depth: 0,
        pathPublicCategoryIds: [tradingCardGamesId],
        displayOrder: 20,
      },
      {
        publicCategoryId: marvelId,
        parentPublicCategoryId: tradingCardGamesId,
        categoryKey: "marvel",
        name: "Marvel",
        kind: "franchise" as const,
        depth: 1,
        pathPublicCategoryIds: [tradingCardGamesId, marvelId],
        displayOrder: 21,
      },
    ],
    platforms: fixtureConfiguration.platforms.map((platform) =>
      platform.platformKey === "alpha"
        ? {
            ...platform,
            categoryMappings: [{
              sourceValue: "Multisport",
              publicCategoryIds: [
                fixtureIds.rootCategory,
                fixtureIds.childCategory,
              ],
            }],
          }
        : platform),
    collectibles: fixtureConfiguration.collectibles.map((collectible) =>
      collectible.platformKey === "alpha"
        ? {
            ...collectible,
            publicCategoryIds: [tradingCardGamesId, marvelId],
          }
        : collectible),
  };
  const base = fixtureSnapshot({ configuration });
  const mixed = project({
    ...base,
    revisions: base.revisions.map((revision) => {
      if (revision.platformKey !== "alpha") return revision;
      if (revision.recordKind === "pack") {
        return {
          ...revision,
          content: {
            ...(revision.content as Record<string, unknown>),
            name: "Liftoff",
            category: "Multisport",
          },
        };
      }
      if (revision.recordKind === "catalog_asset") {
        return {
          ...revision,
          content: {
            ...(revision.content as Record<string, unknown>),
            category: "Marvel",
          },
        };
      }
      return revision;
    }),
  });
  const liftoff = mixed.repacks.find(({ publicRepackId }) =>
    publicRepackId === fixtureIds.alphaRepack);
  assert.equal(liftoff?.name, "Liftoff");
  assert.equal(liftoff?.contentMode, "mixed");
  assert.deepEqual(
    liftoff?.categories.map(({ publicCategoryId }) => publicCategoryId),
    allCategoryIds,
  );
});
