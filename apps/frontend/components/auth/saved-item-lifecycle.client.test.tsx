import "../../lib/component-render.test-support";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { act, type ReactNode, useEffect, useLayoutEffect } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { JSDOM } from "jsdom";
import { AuthenticatedSavedItemsProvider } from "./AuthenticatedSavedItemsProvider.client";
import { PackScoutAuthContext, type PackScoutAuthStatus, unavailableAuthValue } from "./AuthContext.client";
import { SavedCollectibleButton, SavedRepackButton } from "./SavedItemButton.client";
import type { SavedItemKind } from "./saved-item-presentation";

const publicId = "11111111-1111-5111-8111-111111111111";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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

async function setup(context: TestContext, kind: SavedItemKind, saved: boolean) {
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
  const writes: ReturnType<typeof deferred<{ saved: boolean; prunedUnavailable: boolean }>>[] = [];
  const reads: ReturnType<typeof deferred<ReturnType<typeof membership>>>[] = [];
  const calls: unknown[] = [];
  context.mock.method(client, "mutation", (mutation: FunctionReference<"mutation">, input: unknown) => {
    calls.push({ name: getFunctionName(mutation), input });
    const write = deferred<{ saved: boolean; prunedUnavailable: boolean }>();
    writes.push(write);
    return write.promise;
  });
  context.mock.method(client, "query", (query: FunctionReference<"query">) => {
    assert.equal(getFunctionName(query), "savedItems:getSavedItemIds");
    const read = deferred<ReturnType<typeof membership>>();
    reads.push(read);
    return read.promise;
  });

  const button = () => {
    const result = container.querySelector("button");
    assert.ok(result);
    return result;
  };
  const render = async (options: Readonly<{
    status?: PackScoutAuthStatus;
    session?: string;
    attempt?: number;
    interact?: () => void;
    passive?: () => void;
    mounted?: boolean;
  }> = {}) => act(async () => root.render(
    <PackScoutAuthContext.Provider value={{ ...unavailableAuthValue, status: options.status ?? "signed_in" }}>
      <ConvexProvider client={client}>
        <CommitInteraction attempt={options.attempt ?? 0} interact={options.interact ?? (() => undefined)} passive={options.passive ?? (() => undefined)}>
          {options.mounted !== false && <AuthenticatedSavedItemsProvider key={options.session ?? "user-a"}>
            {kind === "repack" ? <SavedRepackButton publicRepackId={publicId} /> : <SavedCollectibleButton publicCollectibleId={publicId} />}
          </AuthenticatedSavedItemsProvider>}
        </CommitInteraction>
      </ConvexProvider>
    </PackScoutAuthContext.Provider>,
  ));
  return {
    button, calls, container, membership, reads, render, writes,
    status: () => container.querySelector('[role="status"]'),
    clickTwice: () => act(async () => { button().click(); button().click(); }),
    updateIds(present: boolean) {
      cachedIds = membership(present);
      for (const notify of subscribers) notify();
      return cachedIds;
    },
  };
}

for (const kind of ["repack", "collectible"] as const) {
  for (const saved of [true, false]) {
    test(`cached-ID remount accepts ${kind} ${saved ? "save" : "removal"} before passive effects`, async (context) => {
      const ui = await setup(context, kind, saved);
      const { button, calls } = ui;
      let passiveRan = false;
      const observations: unknown[] = [];
      const interact = () => {
        observations.push({ disabled: button().disabled, pressed: button().getAttribute("aria-pressed"), passiveRan });
        button().click();
        button().click();
        observations.push({ writesBeforePassive: calls.length });
      };
      const passive = () => { passiveRan = true; };
      await ui.render();
      await ui.render({ session: "remount", attempt: 1, interact, passive });
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
      await act(async () => ui.writes[0].resolve({ saved, prunedUnavailable: false }));
      assert.equal(ui.reads.length, 1);
      assert.equal(button().disabled, true);
      assert.equal(button().getAttribute("aria-pressed"), String(!saved));
      assert.equal(ui.status()?.getAttribute("data-tone"), "neutral");
      await act(async () => ui.reads[0].resolve(ui.updateIds(saved)));
      assert.equal(button().disabled, false);
      assert.equal(button().getAttribute("aria-pressed"), String(saved));
      assert.equal(ui.status()?.getAttribute("data-tone"), "success");
    });

    for (const timing of ["during", "after"] as const) {
      for (const outcome of ["success", "refusal"] as const) {
        test(`${kind} ${saved ? "save" : "removal"} retains ${outcome} ${timing} same-user auth refresh`, async (context) => {
          const ui = await setup(context, kind, saved);
          await ui.render();
          await ui.clickTwice();
          assert.equal(ui.calls.length, 1);
          await ui.render({ status: "loading" });
          assert.equal(ui.button().disabled, true);
          assert.equal(ui.button().textContent, "Checking account…");
          await ui.clickTwice();
          assert.equal(ui.calls.length, 1, "refresh cannot issue new writes");
          if (timing === "after") await ui.render();
          await act(async () => {
            if (outcome === "success") ui.writes[0].resolve({ saved, prunedUnavailable: false });
            else ui.writes[0].reject({ data: { code: "SAVED_ITEMS_STATE_CONFLICT", message: "private refusal" } });
          });
          if (timing === "during") await ui.render();
          assert.equal(ui.button().getAttribute("aria-pressed"), String(!saved));
          if (outcome === "success") {
            assert.equal(ui.reads.length, 1, "refresh retains the authoritative reconciliation");
            assert.equal(ui.button().disabled, true);
            assert.equal(ui.button().textContent, saved ? "Saving…" : "Removing…");
            await ui.clickTwice();
            assert.equal(ui.calls.length, 1, "original intent remains pending after refresh");
            assert.equal(ui.status()?.getAttribute("data-tone"), "neutral");
            await act(async () => ui.reads[0].resolve(ui.updateIds(saved)));
            assert.equal(ui.button().getAttribute("aria-pressed"), String(saved));
            assert.equal(ui.status()?.getAttribute("data-tone"), "success");
          } else {
            assert.equal(ui.reads.length, 0);
            assert.equal(ui.status()?.getAttribute("data-tone"), "error");
            assert.match(ui.status()?.textContent ?? "", /Refresh the page/);
            assert.equal(ui.container.textContent?.includes("private refusal"), false);
          }
          assert.equal(ui.button().disabled, false);
        });
      }
    }

    for (const reconciled of [true, false]) {
      test(`${kind} ${saved ? "save" : "removal"} retains reconciliation ${reconciled ? "success" : "failure"} completed during auth refresh`, async (context) => {
        const ui = await setup(context, kind, saved);
        await ui.render();
        await ui.clickTwice();
        await act(async () => ui.writes[0].resolve({ saved, prunedUnavailable: false }));
        assert.equal(ui.reads.length, 1);
        await ui.render({ status: "loading" });
        await act(async () => ui.reads[0].resolve(reconciled ? ui.updateIds(saved) : ui.membership(!saved)));
        await ui.render();
        assert.equal(ui.button().disabled, false);
        assert.equal(ui.button().getAttribute("aria-pressed"), String(reconciled ? saved : !saved));
        assert.equal(ui.status()?.getAttribute("data-tone"), reconciled ? "success" : "error");
        if (!reconciled) assert.match(ui.status()?.textContent ?? "", /Refresh the page/);
      });
    }

    for (const end of ["sign-out", "identity change", "unmount"] as const) {
      for (const stage of ["mutation", "mutation refusal", "reconciliation"] as const) {
        test(`${end} isolates pending ${kind} ${saved ? "save" : "removal"} ${stage}`, async (context) => {
          const ui = await setup(context, kind, saved);
          await ui.render();
          await ui.clickTwice();
          if (stage === "reconciliation") await act(async () => ui.writes[0].resolve({ saved, prunedUnavailable: false }));
          await ui.render(end === "sign-out" ? { status: "signed_out" } : end === "identity change" ? { session: "user-b" } : { mounted: false });
          await ui.render({ session: end === "identity change" ? "user-b" : "user-a" });
          await ui.clickTwice();
          assert.equal(ui.calls.length, 2, "new session accepts exactly one new intent");
          await act(async () => {
            if (stage === "reconciliation") ui.reads[0].reject({ data: { code: "AUTH_REQUIRED" } });
            else if (stage === "mutation refusal") ui.writes[0].reject({ data: { code: "ACCOUNT_SUSPENDED" } });
            else ui.writes[0].resolve({ saved, prunedUnavailable: false });
          });
          assert.equal(ui.reads.length, stage === "reconciliation" ? 1 : 0, "stale mutation cannot read current session IDs");
          assert.equal(ui.button().disabled, true, "stale completion cannot clear current pending work");
          assert.equal(ui.status()?.getAttribute("data-tone"), "neutral");
          assert.equal(ui.button().getAttribute("aria-pressed"), String(!saved));
          await act(async () => ui.writes[1].resolve({ saved, prunedUnavailable: false }));
          await act(async () => ui.reads.at(-1)!.resolve(ui.updateIds(saved)));
          assert.equal(ui.button().disabled, false);
          assert.equal(ui.button().getAttribute("aria-pressed"), String(saved));
          assert.equal(ui.status()?.getAttribute("data-tone"), "success");
        });
      }
    }
  }
}
