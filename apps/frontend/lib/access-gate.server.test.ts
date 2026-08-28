import assert from "node:assert/strict";
import { test } from "node:test";
import { ConvexError } from "convex/values";
import {
  createAccessGuardedHandler,
  createVisitorAccessGate,
  GATE_STATUS_TTL_MS,
  gatedSurfaceRobots,
  resolveAccessRoute,
  resolveGatedRoute,
  resolveRootRoute,
  robotsPolicyForGateStatus,
  rootRouteMetadata,
  shellSurfaceForDecision,
  type AccessGateDependencies,
  type VisitorAccessDecision,
} from "./access-gate.server";
import { LANDING_METADATA } from "./landing-content";

const VALID_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJkaWQifQ.c2ln";

type GateHarness = Readonly<{
  gate: ReturnType<typeof createVisitorAccessGate>;
  calls: { gateStatus: number; myAccess: number };
  setNow: (value: number) => void;
}>;

function harness(
  overrides: Partial<AccessGateDependencies> = {},
): GateHarness {
  const calls = { gateStatus: 0, myAccess: 0 };
  let currentTime = 1_000_000;
  const dependencies: AccessGateDependencies = {
    convexUrl: () => "https://backend.convex.cloud",
    readIdentityToken: async () => null,
    fetchGateStatus: async () => {
      calls.gateStatus += 1;
      return { closedBetaActive: true };
    },
    fetchMyAccess: async () => {
      calls.myAccess += 1;
      return { admitted: true, reason: "approved" };
    },
    now: () => currentTime,
    ...overrides,
  };
  return {
    gate: createVisitorAccessGate(dependencies),
    calls,
    setNow: (value) => {
      currentTime = value;
    },
  };
}

function decision(outcome: VisitorAccessDecision["outcome"]) {
  return (outcome === "held"
    ? { outcome, reason: "awaiting_review" }
    : { outcome }) as VisitorAccessDecision;
}

// --- Resolution -------------------------------------------------------------

test("with the switch off every visitor resolves to public and no identity is read", async () => {
  const { gate, calls } = harness({
    fetchGateStatus: async () => ({ closedBetaActive: false }),
    readIdentityToken: async () => VALID_TOKEN,
  });
  assert.deepEqual(await gate.resolve(), { outcome: "public" });
  assert.equal(calls.myAccess, 0);
});

test("with the switch on a visitor with no identity cookie is signed out without a backend call", async () => {
  const { gate, calls } = harness();
  assert.deepEqual(await gate.resolve(), { outcome: "signed_out" });
  assert.equal(calls.myAccess, 0);
});

test("a cookie that is not token-shaped reads as signed out and never travels", async () => {
  for (const value of ["", "garbage", "a.b", "<script>", "a a.b b.c c", `${"x".repeat(5000)}.y.z`]) {
    const { gate, calls } = harness({ readIdentityToken: async () => value });
    assert.deepEqual(await gate.resolve(), { outcome: "signed_out" }, value);
    assert.equal(calls.myAccess, 0, value);
  }
});

test("a verified admitted identity resolves to admitted", async () => {
  const { gate } = harness({ readIdentityToken: async () => VALID_TOKEN });
  assert.deepEqual(await gate.resolve(), { outcome: "admitted" });
});

test("each held reason survives the resolution intact", async () => {
  for (const reason of ["awaiting_review", "declined", "suspended"] as const) {
    const { gate } = harness({
      readIdentityToken: async () => VALID_TOKEN,
      fetchMyAccess: async () => ({ admitted: false, reason }),
    });
    assert.deepEqual(await gate.resolve(), { outcome: "held", reason });
  }
});

test("an undetermined backend answer stays undetermined, never admitted", async () => {
  const { gate } = harness({
    readIdentityToken: async () => VALID_TOKEN,
    fetchMyAccess: async () => ({ admitted: false, reason: "undetermined" }),
  });
  assert.deepEqual(await gate.resolve(), { outcome: "undetermined" });
});

test("a backend identity refusal reads as signed out", async () => {
  for (const refusal of [
    new ConvexError({ code: "AUTH_REQUIRED" }),
    new Error("401 Unauthenticated: bad token"),
  ]) {
    const { gate } = harness({
      readIdentityToken: async () => VALID_TOKEN,
      fetchMyAccess: async () => {
        throw refusal;
      },
    });
    assert.deepEqual(await gate.resolve(), { outcome: "signed_out" });
  }
});

test("any other identity-read failure fails closed as undetermined", async () => {
  for (const failure of [
    new Error("fetch failed"),
    new ConvexError({ code: "SOMETHING_ELSE" }),
    "not-even-an-error",
  ]) {
    const { gate } = harness({
      readIdentityToken: async () => VALID_TOKEN,
      fetchMyAccess: async () => {
        throw failure;
      },
    });
    assert.deepEqual(await gate.resolve(), { outcome: "undetermined" });
  }
});

test("an unreadable or malformed gate status fails closed and is never cached", async () => {
  let attempts = 0;
  const { gate } = harness({
    fetchGateStatus: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("backend down");
      if (attempts === 2) {
        return { closedBetaActive: "yes" } as unknown as {
          closedBetaActive: boolean;
        };
      }
      return { closedBetaActive: false };
    },
  });
  assert.deepEqual(await gate.resolve(), { outcome: "undetermined" });
  assert.deepEqual(await gate.resolve(), { outcome: "undetermined" });
  // The failure was not cached: the third request asks again and recovers.
  assert.deepEqual(await gate.resolve(), { outcome: "public" });
});

test("a deployment with no backend origin fails closed with zero calls", async () => {
  const { gate, calls } = harness({ convexUrl: () => null });
  assert.deepEqual(await gate.resolve(), { outcome: "undetermined" });
  assert.equal(calls.gateStatus + calls.myAccess, 0);
});

test("a hung backend read resolves fail-closed instead of hanging the page", async () => {
  const { gate } = harness({
    resolutionTimeoutMs: 10,
    readIdentityToken: async () => VALID_TOKEN,
    fetchMyAccess: () => new Promise(() => undefined),
  });
  assert.deepEqual(await gate.resolve(), { outcome: "undetermined" });
});

// --- Caching bounds ---------------------------------------------------------

test("the switch is cached per process and re-read after the TTL", async () => {
  const { gate, calls, setNow } = harness();
  await gate.resolve();
  await gate.resolve();
  assert.equal(calls.gateStatus, 1);
  setNow(1_000_000 + GATE_STATUS_TTL_MS + 1);
  await gate.resolve();
  assert.equal(calls.gateStatus, 2);
});

test("a switch flip is visible within one TTL", async () => {
  let active = true;
  const { gate, setNow } = harness({
    fetchGateStatus: async () => ({ closedBetaActive: active }),
  });
  assert.equal((await gate.resolve()).outcome, "signed_out");
  active = false;
  assert.equal((await gate.resolve()).outcome, "signed_out");
  setNow(1_000_000 + GATE_STATUS_TTL_MS + 1);
  assert.equal((await gate.resolve()).outcome, "public");
});

test("the identity decision is never cached: a revocation bites on the very next resolution", async () => {
  let admitted = true;
  const { gate, calls } = harness({
    readIdentityToken: async () => VALID_TOKEN,
    fetchMyAccess: async () => {
      calls.myAccess += 0;
      return admitted
        ? { admitted: true, reason: "approved" }
        : { admitted: false, reason: "declined" };
    },
  });
  assert.deepEqual(await gate.resolve(), { outcome: "admitted" });
  admitted = false;
  assert.deepEqual(await gate.resolve(), {
    outcome: "held",
    reason: "declined",
  });
});

test("a warm request path costs exactly one backend resolution", async () => {
  const { gate, calls } = harness({
    readIdentityToken: async () => VALID_TOKEN,
  });
  await gate.resolve(); // cold: one status read + one identity read
  const afterCold = { ...calls };
  await gate.resolve();
  assert.equal(calls.gateStatus, afterCold.gateStatus);
  assert.equal(calls.myAccess, afterCold.myAccess + 1);
});

// --- Routing totality -------------------------------------------------------

test("routing outcomes are explicit and total for every decision", () => {
  assert.deepEqual(resolveRootRoute(decision("public")), { kind: "product" });
  assert.deepEqual(resolveRootRoute(decision("admitted")), { kind: "product" });
  assert.deepEqual(resolveRootRoute(decision("signed_out")), {
    kind: "landing",
  });
  assert.deepEqual(resolveRootRoute(decision("held")), {
    kind: "redirect",
    destination: "/access",
  });
  assert.deepEqual(resolveRootRoute(decision("undetermined")), {
    kind: "redirect",
    destination: "/access",
  });

  assert.deepEqual(resolveGatedRoute(decision("public")), { kind: "render" });
  assert.deepEqual(resolveGatedRoute(decision("admitted")), { kind: "render" });
  assert.deepEqual(resolveGatedRoute(decision("signed_out")), {
    kind: "redirect",
    destination: "/",
  });
  assert.deepEqual(resolveGatedRoute(decision("held")), {
    kind: "redirect",
    destination: "/access",
  });
  assert.deepEqual(resolveGatedRoute(decision("undetermined")), {
    kind: "redirect",
    destination: "/access",
  });

  assert.deepEqual(resolveAccessRoute(decision("held")), {
    kind: "hold",
    reason: "awaiting_review",
  });
  assert.deepEqual(resolveAccessRoute(decision("undetermined")), {
    kind: "hold",
    reason: "undetermined",
  });
  for (const outcome of ["public", "admitted", "signed_out"] as const) {
    assert.deepEqual(resolveAccessRoute(decision(outcome)), {
      kind: "redirect",
      destination: "/",
    });
  }
});

test("no decision can produce a redirect cycle between the root and the holding surface", () => {
  for (const outcome of [
    "public",
    "admitted",
    "signed_out",
    "held",
    "undetermined",
  ] as const) {
    const d = decision(outcome);
    const root = resolveRootRoute(d);
    const access = resolveAccessRoute(d);
    // Whenever the root hands a decision to /access, /access renders it —
    // and whenever /access sends a decision back, the root renders it.
    if (root.kind === "redirect") assert.equal(access.kind, "hold");
    if (access.kind === "redirect") assert.notEqual(root.kind, "redirect");
  }
});

test("the shell shows product chrome only to visitors the product renders for", () => {
  assert.equal(shellSurfaceForDecision(decision("public")), "product");
  assert.equal(shellSurfaceForDecision(decision("admitted")), "product");
  for (const outcome of ["signed_out", "held", "undetermined"] as const) {
    assert.equal(shellSurfaceForDecision(decision(outcome)), "gateway");
  }
});

// --- Switch-off equivalence -------------------------------------------------

test("with the switch off the root serves the product to anonymous visitors and all indexing exclusions lift", async () => {
  const { gate } = harness({
    fetchGateStatus: async () => ({ closedBetaActive: false }),
  });
  const anonymous = await gate.resolve();
  assert.deepEqual(resolveRootRoute(anonymous), { kind: "product" });
  assert.deepEqual(resolveGatedRoute(anonymous), { kind: "render" });
  assert.deepEqual(resolveAccessRoute(anonymous), {
    kind: "redirect",
    destination: "/",
  });
  assert.equal(gatedSurfaceRobots(anonymous), undefined);
  assert.deepEqual(rootRouteMetadata(anonymous), {});
  assert.deepEqual(robotsPolicyForGateStatus(false), {
    rules: [{ userAgent: "*", allow: "/" }],
  });
});

// --- Indexing ---------------------------------------------------------------

test("while the beta is on gated surfaces are noindex and the root serves the indexable landing metadata", () => {
  for (const outcome of ["admitted", "signed_out", "held", "undetermined"] as const) {
    assert.deepEqual(gatedSurfaceRobots(decision(outcome)), {
      index: false,
      follow: false,
    });
  }
  assert.equal(rootRouteMetadata(decision("signed_out")), LANDING_METADATA);
  assert.equal(LANDING_METADATA.robots, undefined);
  assert.deepEqual(rootRouteMetadata(decision("admitted")).robots, {
    index: false,
    follow: false,
  });
});

test("an unknown switch keeps the crawler exclusions in place", () => {
  for (const status of [true, null]) {
    const policy = robotsPolicyForGateStatus(status);
    const rule = Array.isArray(policy.rules) ? policy.rules[0] : policy.rules;
    assert.deepEqual(rule?.disallow, ["/access", "/api/", "/learn", "/packs"]);
    assert.equal(rule?.allow, "/");
  }
});

// --- Data-route guarding ----------------------------------------------------

test("an unadmitted request never reaches the catalog search read", async () => {
  for (const outcome of ["signed_out", "held"] as const) {
    let reads = 0;
    const guarded = createAccessGuardedHandler(
      async () => decision(outcome),
      async () => {
        reads += 1;
        return Response.json({ leaked: true });
      },
    );
    const response = await guarded(new Request("https://packscout.example/api/collectibles/search?q=charizard"));
    assert.equal(reads, 0);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "ACCESS_REQUIRED",
      error: "An approved beta account is required.",
      retryable: false,
    });
  }
});

test("an unresolved decision refuses as unavailable rather than admitting", async () => {
  for (const resolveDecision of [
    async () => decision("undetermined"),
    async (): Promise<VisitorAccessDecision> => {
      throw new Error("resolver blew up");
    },
  ]) {
    let reads = 0;
    const guarded = createAccessGuardedHandler(resolveDecision, async () => {
      reads += 1;
      return Response.json({ leaked: true });
    });
    const response = await guarded(new Request("https://packscout.example/api/collectibles/search?q=x"));
    assert.equal(reads, 0);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "ACCESS_UNAVAILABLE",
      error: "Access could not be confirmed. Try again shortly.",
      retryable: true,
    });
  }
});

test("admitted and fully public callers pass through to the wrapped handler", async () => {
  for (const outcome of ["public", "admitted"] as const) {
    const guarded = createAccessGuardedHandler(
      async () => decision(outcome),
      async () => Response.json({ ok: true, data: "payload" }),
    );
    const response = await guarded(new Request("https://packscout.example/api/collectibles/search?q=x"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: "payload" });
  }
});
