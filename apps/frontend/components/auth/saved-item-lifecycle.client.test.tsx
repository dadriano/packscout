import "../../lib/component-render.test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, type ReactNode, useEffect, useLayoutEffect } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { JSDOM } from "jsdom";
import { AuthenticatedSavedItemsProvider } from "./AuthenticatedSavedItemsProvider.client";
import { PackScoutAuthContext, unavailableAuthValue } from "./AuthContext.client";
import { SavedCollectibleButton, SavedRepackButton } from "./SavedItemButton.client";

const publicId = "11111111-1111-5111-8111-111111111111";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** An ancestor layout effect runs after the provider commits, before passive effects. */
function CommitInteraction({ attempt, interact, passive, children }: Readonly<{
  attempt: number;
  interact: () => void;
  passive: () => void;
  children: ReactNode;
}>) {
  useLayoutEffect(() => { if (attempt === 1) interact(); }, [attempt, interact]);
  useEffect(() => { if (attempt === 1) passive(); }, [attempt, passive]);
  return children;
}

for (const kind of ["repack", "collectible"] as const) {
  for (const saved of [true, false]) {
    test(`cached-ID remount accepts ${kind} ${saved ? "save" : "removal"} before passive effects`, async (context) => {
      const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "https://packscout.test/" });
      const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
      const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
      const { createRoot } = await import("react-dom/client");
      const container = dom.window.document.getElementById("root")!;
      const root = createRoot(container);
      const client = new ConvexReactClient("https://saved-items-test.convex.cloud");
      context.after(async () => {
        await act(async () => root.unmount());
        await client.close();
        dom.window.close();
        for (const [key, descriptor] of previous) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      });

      const membership = (present: boolean) => ({
        savedRepackIds: kind === "repack" && present ? [publicId] : [],
        savedCollectibleIds: kind === "collectible" && present ? [publicId] : [],
      });
      let cachedIds = membership(!saved);
      const subscribers = new Set<() => void>();
      context.mock.method(client, "watchQuery", (query: FunctionReference<"query">) => {
        const name = getFunctionName(query);
        assert.ok(name === "savedItems:getSavedItemIds" || name === "productUsers:getMyStanding");
        return {
          localQueryResult: () => name === "savedItems:getSavedItemIds" ? cachedIds : { standing: "active" },
          onUpdate: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
          localQueryLogs: () => undefined,
          journal: () => undefined,
        };
      });
      const write = deferred<{ saved: boolean; prunedUnavailable: boolean }>();
      const read = deferred<ReturnType<typeof membership>>();
      const calls: unknown[] = [];
      context.mock.method(client, "mutation", (mutation: FunctionReference<"mutation">, input: unknown) => {
        calls.push({ name: getFunctionName(mutation), input });
        return write.promise;
      });
      let reads = 0;
      context.mock.method(client, "query", (query: FunctionReference<"query">) => {
        assert.equal(getFunctionName(query), "savedItems:getSavedItemIds");
        reads += 1;
        return read.promise;
      });

      const button = () => {
        const result = container.querySelector("button");
        assert.ok(result);
        return result;
      };
      let passiveRan = false;
      const observations: unknown[] = [];
      const interact = () => {
        observations.push({ disabled: button().disabled, pressed: button().getAttribute("aria-pressed"), passiveRan });
        button().click();
        button().click();
        observations.push({ writesBeforePassive: calls.length });
      };
      const passive = () => { passiveRan = true; };
      const render = (attempt: number) => (
        <PackScoutAuthContext.Provider value={{ ...unavailableAuthValue, status: "signed_in" }}>
          <ConvexProvider client={client}>
            <CommitInteraction attempt={attempt} interact={interact} passive={passive}>
              <AuthenticatedSavedItemsProvider key={attempt}>
                {kind === "repack" ? <SavedRepackButton publicRepackId={publicId} /> : <SavedCollectibleButton publicCollectibleId={publicId} />}
              </AuthenticatedSavedItemsProvider>
            </CommitInteraction>
          </ConvexProvider>
        </PackScoutAuthContext.Provider>
      );
      await act(async () => root.render(render(0)));
      await act(async () => root.render(render(1)));
      assert.deepEqual(observations, [
        { disabled: false, pressed: String(!saved), passiveRan: false },
        { writesBeforePassive: 1 },
      ]);
      assert.deepEqual(calls, [{
        name: kind === "repack" ? "savedItems:setSavedRepack" : "savedItems:setSavedCollectible",
        input: kind === "repack" ? { publicRepackId: publicId, saved } : { publicCollectibleId: publicId, saved },
      }]);
      assert.equal(button().disabled, true);
      assert.equal(button().getAttribute("aria-pressed"), String(!saved));
      assert.equal(button().textContent, saved ? "Saving…" : "Removing…");
      await act(async () => write.resolve({ saved, prunedUnavailable: false }));
      assert.equal(reads, 1);
      assert.equal(button().disabled, true);
      assert.equal(button().getAttribute("aria-pressed"), String(!saved));
      assert.equal(container.querySelector('[role="status"]')?.getAttribute("data-tone"), "neutral");

      await act(async () => {
        cachedIds = membership(saved);
        for (const notify of subscribers) notify();
        read.resolve(cachedIds);
      });
      assert.equal(button().disabled, false);
      assert.equal(button().getAttribute("aria-pressed"), String(saved));
      assert.equal(container.querySelector('[role="status"]')?.getAttribute("data-tone"), "success");
    });
  }
}
