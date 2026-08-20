import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const header = readFileSync(new URL("./DashboardPageHeader.tsx", import.meta.url), "utf8");
const overviewPage = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const repacksPage = readFileSync(new URL("../../app/packs/page.tsx", import.meta.url), "utf8");

test("the financial disclaimer follows dashboard content instead of the page heading", () => {
  assert.equal(header.includes("dashboard-disclaimer"), false);
  assert.match(overviewPage, /<DashboardDisclaimer \/>/);
  assert.match(repacksPage, /<DashboardDisclaimer \/>/);
});
