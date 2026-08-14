import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_BOOTSTRAP_SCRIPT } from "./theme-bootstrap";
import { isResolvedTheme, resolveInitialTheme } from "./theme.client";

test("theme resolution prefers a valid device-local choice, then the system", () => {
  assert.equal(resolveInitialTheme("dark", false), "dark");
  assert.equal(resolveInitialTheme("light", true), "light");
  assert.equal(resolveInitialTheme("sepia", true), "dark");
  assert.equal(resolveInitialTheme(null, false), "light");
  assert.equal(isResolvedTheme("dark"), true);
  assert.equal(isResolvedTheme("system"), false);
});

test("the pre-paint bootstrap applies persisted dark theme and browser metadata", () => {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const themeMeta = {
    content: "",
    setAttribute(_name: string, value: string) {
      this.content = value;
    },
  };

  runInNewContext(THEME_BOOTSTRAP_SCRIPT, {
    document: {
      documentElement: root,
      querySelector: () => themeMeta,
    },
    window: {
      localStorage: { getItem: () => "dark" },
      matchMedia: () => ({ matches: false }),
    },
  });

  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(themeMeta.content, "#030b13");
});

test("the pre-paint bootstrap survives blocked storage and follows system theme", () => {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };

  assert.doesNotThrow(() =>
    runInNewContext(THEME_BOOTSTRAP_SCRIPT, {
      document: {
        documentElement: root,
        querySelector: () => null,
      },
      window: {
        localStorage: {
          getItem() {
            throw new Error("blocked");
          },
        },
        matchMedia: () => ({ matches: true }),
      },
    }),
  );
  assert.equal(root.dataset.theme, "dark");
});
