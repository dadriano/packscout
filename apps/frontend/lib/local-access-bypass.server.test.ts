import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAccessGuardedHandler,
  createVisitorAccessGate,
  gatedSurfaceRobots,
  resolveAccessRoute,
  resolveGatedRoute,
  resolveRootRoute,
  resolveWatchlistRoute,
  rootRouteMetadata,
  shellSurfaceForDecision,
} from "./access-gate.server";
import { localAccessBypassEnabled } from "./local-access-bypass.server";

const enabledEnvironment = {
  NODE_ENV: "development",
  PACKSCOUT_LOCAL_ACCESS_BYPASS: "1",
  PACKSCOUT_FRONTEND_HOST: "127.0.0.1",
};

test("local preview requires an exact opt-in and development runtime", () => {
  for (const NODE_ENV of [undefined, "", "test", "production", "preview"]) {
    assert.equal(localAccessBypassEnabled({ ...enabledEnvironment, NODE_ENV }, "127.0.0.1:5199"), false);
  }
  for (const flag of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
    assert.equal(localAccessBypassEnabled({ ...enabledEnvironment, PACKSCOUT_LOCAL_ACCESS_BYPASS: flag }, "127.0.0.1:5199"), false);
  }
});

test("both the configured listener and request authority must be loopback", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    for (const authority of ["127.0.0.1:5199", "localhost:5100", "[::1]:5199", "localhost"]) {
      assert.equal(localAccessBypassEnabled({ ...enabledEnvironment, PACKSCOUT_FRONTEND_HOST: host }, authority), true);
    }
  }
  for (const host of [undefined, "", "0.0.0.0", "::", "192.168.1.2", "packscout.com"]) {
    assert.equal(localAccessBypassEnabled({ ...enabledEnvironment, PACKSCOUT_FRONTEND_HOST: host }, "127.0.0.1:5199"), false);
  }
  for (const authority of [
    null, "", "packscout.com", "192.168.1.2:5199", "localhost.example:5199",
    "localhost@evil.example", "localhost/path", "127.0.0.1:0", "127.0.0.1:65536",
    "127.0.0.1:5199,evil.example", "127.0.0.1:5199\n", " http://localhost:5199",
  ]) {
    assert.equal(localAccessBypassEnabled(enabledEnvironment, authority), false, String(authority));
  }
});

function previewGate(allowLocalPreview: () => Promise<boolean>) {
  return createVisitorAccessGate({
    convexUrl: () => "https://backend.convex.cloud",
    allowLocalPreview,
    fetchGateStatus: async () => ({ closedBetaActive: true }),
    readIdentityToken: async () => null,
    fetchMyAccess: async () => {
      assert.fail("A preview must not manufacture an authenticated backend call.");
    },
  });
}

test("enabled preview opens catalog routes without creating a signed-in identity", async () => {
  const gate = previewGate(async () => localAccessBypassEnabled(enabledEnvironment, "127.0.0.1:5199"));
  const decision = await gate.resolve();
  assert.deepEqual(decision, { outcome: "local_preview" });
  assert.deepEqual(resolveRootRoute(decision), { kind: "product" });
  assert.deepEqual(resolveGatedRoute(decision), { kind: "render" });
  assert.deepEqual(resolveWatchlistRoute(decision), { kind: "render" });
  assert.deepEqual(resolveAccessRoute(decision), { kind: "redirect", destination: "/" });
  assert.equal(shellSurfaceForDecision(decision), "product");
  assert.deepEqual(gatedSurfaceRobots(decision), { index: false, follow: false });
  assert.deepEqual(rootRouteMetadata(decision).robots, { index: false, follow: false });
  assert.equal(await gate.readGateStatus(), true, "The production beta switch stays on.");
});

test("the bypass is checked per request and production still requires admission", async () => {
  let environment = { ...enabledEnvironment };
  let host = "127.0.0.1:5199";
  const gate = previewGate(async () => localAccessBypassEnabled(environment, host));
  assert.equal((await gate.resolve()).outcome, "local_preview");
  environment.NODE_ENV = "production";
  assert.equal((await gate.resolve()).outcome, "signed_out");
  environment = { ...enabledEnvironment, PACKSCOUT_LOCAL_ACCESS_BYPASS: "0" };
  assert.equal((await gate.resolve()).outcome, "signed_out");
  environment = { ...enabledEnvironment };
  host = "packscout.com";
  assert.equal((await gate.resolve()).outcome, "signed_out");
});

test("an unreadable local preview decision fails closed", async () => {
  const gate = previewGate(async () => { throw new Error("Missing request context"); });
  assert.deepEqual(await gate.resolve(), { outcome: "undetermined" });
});

test("local preview permits catalog reads but never authorizes a write handler", async () => {
  const gate = previewGate(async () => true);
  let calls = 0;
  const handler = createAccessGuardedHandler(gate.resolve, async () => {
    calls += 1;
    return Response.json({ ok: true });
  });
  for (const method of ["GET", "HEAD"]) {
    assert.equal((await handler(new Request("http://127.0.0.1:5199/api/catalog", { method }))).status, 200);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await handler(new Request("http://127.0.0.1:5199/api/catalog", { method }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "ACCESS_REQUIRED");
  }
  assert.equal(calls, 2);
});
