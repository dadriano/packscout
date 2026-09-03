import nodeModule from "node:module";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type LoadHookContext = Readonly<Record<string, unknown>>;
type LoadHookResult = {
  format?: string;
  source?: string;
  shortCircuit?: boolean;
};
type LoadHook = (
  url: string,
  context: LoadHookContext,
  nextLoad: (url: string, context?: LoadHookContext) => LoadHookResult,
) => LoadHookResult;

// registerHooks is available on Node 22.15+, ahead of the pinned @types/node.
const { registerHooks } = nodeModule as unknown as {
  registerHooks: (hooks: { load: LoadHook }) => void;
};

/**
 * Server-render support for component behavior tests. CSS module imports are
 * stubbed with a proxy that returns the class name, so components render
 * under node:test exactly as the Next.js server would render them; effects
 * and subscriptions do not run, which is precisely the hydration-safe
 * server-snapshot path the confidence clock must preserve.
 *
 * Import this module before any component import so the hook is registered
 * first (ES module evaluation is depth-first in declaration order).
 */

declare global {
  var __packscoutCssModuleStubRegistered: boolean | undefined;
}

if (globalThis.__packscoutCssModuleStubRegistered !== true) {
  registerHooks({
    load(url: string, context: LoadHookContext, nextLoad) {
      if (url.split("?")[0]?.endsWith(".css")) {
        return {
          format: "module",
          source:
            "export default new Proxy({}, { get: (_, name) => String(name) });",
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  globalThis.__packscoutCssModuleStubRegistered = true;
}

export function renderStatic(element: ReactElement): string {
  return renderToStaticMarkup(element);
}
