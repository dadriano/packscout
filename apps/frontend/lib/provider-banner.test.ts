import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import sharp from "sharp";
import {
  DASHBOARD_PROVIDERS,
  dashboardHrefFor,
  parseDashboardProviderQuery,
  providerBannerFor,
} from "./provider-banner";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("provider query flags resolve only the two approved campaigns", () => {
  assert.deepEqual(parseDashboardProviderQuery(new URLSearchParams()), {
    ok: true,
    provider: null,
  });
  assert.deepEqual(parseDashboardProviderQuery(new URLSearchParams("underdog")), {
    ok: true,
    provider: "underdog",
  });
  assert.deepEqual(parseDashboardProviderQuery(new URLSearchParams("collector")), {
    ok: true,
    provider: "collector",
  });

  for (const query of [
    "underdog=1",
    "underdog&underdog",
    "underdog&collector",
  ]) {
    assert.deepEqual(parseDashboardProviderQuery(new URLSearchParams(query)), {
      ok: false,
    });
  }
});

test("every provider campaign has an accessible destination and compact deployed asset", async () => {
  assert.equal(dashboardHrefFor(), "/");

  assert.equal(
    providerBannerFor("underdog").destinationHref,
    "https://www.underdogsports.com/",
  );
  assert.equal(
    providerBannerFor("collector").destinationHref,
    "https://collectorcrypt.com/",
  );

  for (const provider of DASHBOARD_PROVIDERS) {
    const banner = providerBannerFor(provider);
    const assetPath = path.join(frontendRoot, "public", banner.imageSrc.slice(1));
    assert.equal(dashboardHrefFor(provider), banner.dashboardHref);
    assert.ok(banner.displayName.length > 0);
    assert.ok(banner.linkLabel.includes(banner.displayName));
    assert.doesNotThrow(() => new URL(banner.destinationHref));
    assert.ok(
      existsSync(assetPath),
      `${banner.imageSrc} should exist under public`,
    );
    const metadata = await sharp(assetPath).metadata();
    assert.deepEqual(
      { width: metadata.width, height: metadata.height },
      { width: 1600, height: 225 },
    );
  }
});
