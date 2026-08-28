import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appShellSource = readFileSync(
  new URL("./AppShell.tsx", import.meta.url),
  "utf8",
);
const chromeSource = readFileSync(
  new URL("./ShellChrome.client.tsx", import.meta.url),
  "utf8",
);
const surfaceSource = readFileSync(
  new URL("./ShellSurface.client.tsx", import.meta.url),
  "utf8",
);

test("product navigation, search, and release status render only behind the product face", () => {
  assert.match(chromeSource, /if \(mode !== "product"\) return null;/);
  assert.match(chromeSource, /<PrimaryNavigation \/>/);
  assert.match(chromeSource, /<CatalogSearch \/>/);
  assert.match(chromeSource, /<DataReleaseStatus \/>/);
  // The shell itself no longer mounts them unconditionally.
  assert.equal(appShellSource.includes("PrimaryNavigation"), false);
  assert.equal(appShellSource.includes("CatalogSearch"), false);
  assert.match(appShellSource, /<ShellProductChrome \/>/);
});

test("account and theme controls stay outside the gate so sign-out is reachable from every state", () => {
  assert.match(appShellSource, /<AccountControl \/>/);
  assert.match(appShellSource, /<ThemeControl \/>/);
  const chromeIndex = appShellSource.indexOf("<ShellProductChrome />");
  const accountIndex = appShellSource.indexOf("<AccountControl />");
  assert.ok(chromeIndex !== -1 && accountIndex !== -1);
});

test("the server seeds the first paint and pages re-declare their face on soft navigations", () => {
  assert.match(appShellSource, /initialSurface: ShellSurfaceMode/);
  assert.match(appShellSource, /<ShellSurfaceProvider initialMode=\{initialSurface\}>/);
  assert.match(surfaceSource, /useState<ShellSurfaceMode>\(initialMode\)/);
  // The reporter contributes no markup and only updates the context.
  assert.match(surfaceSource, /export function ShellSurfaceReporter/);
  assert.match(surfaceSource, /return null;/);
});

test("the shell face decides chrome, never data: no reads live in these modules", () => {
  for (const source of [appShellSource, chromeSource, surfaceSource]) {
    assert.equal(source.includes("public-repacks"), false);
    assert.equal(source.includes("fetch("), false);
    assert.equal(source.includes("convex"), false);
  }
});
