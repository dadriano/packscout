import assert from "node:assert/strict";
import { test } from "node:test";
import {
  breadcrumbLabel,
  navigationSections,
  pageTitleForPath,
} from "./admin-routes";

const ADMIN_PERMISSIONS = [
  "operators:manage",
  "providers:view",
  "product_users:view",
  "data_inspection:view",
];

test("the Data section appears only with the data-inspection permission", () => {
  const withPermission = navigationSections(ADMIN_PERMISSIONS);
  const dataSection = withPermission.find((section) => section.id === "data");
  assert.ok(dataSection, "the Data section should be present");
  assert.equal(dataSection.heading, "Data");
  assert.deepEqual(
    dataSection.items.map((item) => item.to),
    ["/data/canonical", "/data/published", "/data/compare"],
  );

  // Absent, not disabled: an operator without the grant sees no such group.
  const without = navigationSections(["providers:view"]);
  assert.equal(
    without.some((section) => section.id === "data"),
    false,
  );
});

test("nested Data destinations keep their own titles", () => {
  assert.equal(pageTitleForPath("/data/canonical"), "Canonical Data");
  assert.equal(pageTitleForPath("/data/published"), "Published Data");
  assert.equal(pageTitleForPath("/data/compare"), "Data Comparison");
});

test("existing single-segment destinations are unaffected", () => {
  assert.equal(pageTitleForPath("/"), "Overview");
  assert.equal(pageTitleForPath("/providers"), "Data Providers");
  assert.equal(pageTitleForPath("/providers/abc/edit"), "Data Providers");
  assert.equal(pageTitleForPath("/nowhere"), "Not found");
});

test("promotion jobs share one title across overview and opaque detail", () => {
  assert.equal(pageTitleForPath("/promotion-jobs"), "Convex Promotion Jobs");
  assert.equal(
    pageTitleForPath("/promotion-jobs/pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g"),
    "Convex Promotion Jobs",
  );
  const pipeline = navigationSections(["providers:view"]).find(
    (section) => section.id === "pipeline",
  );
  assert.equal(
    pipeline?.items.some((item) => item.to === "/promotion-jobs"),
    true,
  );
});

test("breadcrumbs label the Data prefix and its nested destination", () => {
  // The prefix is not a destination; it is labelled as a literal so the trail
  // reads "Data / Canonical Data" rather than repeating a raw segment.
  assert.equal(breadcrumbLabel("/data"), "Data");
  assert.equal(breadcrumbLabel("/data/canonical"), "Canonical Data");
  assert.equal(breadcrumbLabel("/providers"), "Data Providers");
  assert.equal(breadcrumbLabel("/providers/new"), "New");
  // An identifier with no declared label falls back to the raw segment.
  assert.equal(breadcrumbLabel("/runs/run-42"), "run-42");
});
