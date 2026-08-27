import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_SESSION_HINT_KEY,
  AUTH_SESSION_HINT_VALUE,
  type AuthSessionHintStorage,
  clearReturningSessionHint,
  initialAuthBootState,
  logoutAndClearReturningSessionHint,
  readReturningSessionHint,
  reduceAuthBootState,
  shouldInvokeLogin,
  syncReturningSessionHint,
} from "./auth-boot";
import {
  SIGN_OUT_CEILING_MS,
  SIGN_OUT_NOT_CONFIRMED_MESSAGE,
  type SignOutCeilingTimer,
} from "./sign-out-handoff";

function memoryStorage(
  entries: Readonly<Record<string, string>> = {},
): AuthSessionHintStorage & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/**
 * The sign-out ceiling under test time: nothing fires until `elapse` says so,
 * and the requested delay is recorded so the constant the surfaces rely on is
 * the one actually scheduled.
 */
function fakeSignOutCeiling() {
  const requested: number[] = [];
  let due: (() => void) | null = null;
  const timer: SignOutCeilingTimer = (onDue, ms) => {
    requested.push(ms);
    due = onDue;
    return () => {
      due = null;
    };
  };
  return {
    requested,
    timer,
    elapse(): void {
      assert.notEqual(due, null, "the sign-out scheduled no ceiling");
      due?.();
    },
  };
}

test("public auth stays idle until a returning hint or explicit intent", () => {
  assert.deepEqual(initialAuthBootState, {
    phase: "idle",
    loginRequested: false,
  });

  const returning = reduceAuthBootState(initialAuthBootState, {
    type: "returning_session",
  });
  assert.deepEqual(returning, { phase: "loading", loginRequested: false });

  const explicit = reduceAuthBootState(initialAuthBootState, {
    type: "login_intent",
  });
  assert.deepEqual(explicit, { phase: "loading", loginRequested: true });
  assert.deepEqual(reduceAuthBootState(explicit, { type: "login_intent" }), explicit);
});

test("one login intent waits for readiness and is consumed once", () => {
  const requested = reduceAuthBootState(initialAuthBootState, {
    type: "login_intent",
  });
  const loaded = reduceAuthBootState(requested, { type: "provider_loaded" });

  assert.equal(
    shouldInvokeLogin({
      requested: loaded.loginRequested,
      ready: false,
      authenticated: false,
      alreadyInvoked: false,
    }),
    false,
  );
  assert.equal(
    shouldInvokeLogin({
      requested: loaded.loginRequested,
      ready: true,
      authenticated: false,
      alreadyInvoked: false,
    }),
    true,
  );
  assert.equal(
    shouldInvokeLogin({
      requested: loaded.loginRequested,
      ready: true,
      authenticated: false,
      alreadyInvoked: true,
    }),
    false,
  );

  const consumed = reduceAuthBootState(loaded, { type: "login_consumed" });
  assert.deepEqual(consumed, { phase: "ready", loginRequested: false });
  assert.equal(
    shouldInvokeLogin({
      requested: consumed.loginRequested,
      ready: true,
      authenticated: false,
      alreadyInvoked: false,
    }),
    false,
  );
});

test("the returning-session hint is fixed, bounded, and contains no identity", () => {
  const storage = memoryStorage();
  syncReturningSessionHint({ ready: false, authenticated: true }, storage);
  assert.equal(readReturningSessionHint(storage), false);

  syncReturningSessionHint({ ready: true, authenticated: true }, storage);
  assert.equal(readReturningSessionHint(storage), true);
  assert.equal(storage.values.get(AUTH_SESSION_HINT_KEY), AUTH_SESSION_HINT_VALUE);
  assert.ok(AUTH_SESSION_HINT_KEY.length < 64);
  assert.ok(AUTH_SESSION_HINT_VALUE.length < 32);
  assert.equal(AUTH_SESSION_HINT_VALUE.includes("did:"), false);
  assert.equal(AUTH_SESSION_HINT_VALUE.includes("@"), false);

  syncReturningSessionHint({ ready: true, authenticated: false }, storage);
  assert.equal(readReturningSessionHint(storage), false);
});

test("unknown or malformed hint values are purged instead of parsed", () => {
  const storage = memoryStorage({ [AUTH_SESSION_HINT_KEY]: "did:privy:user-a" });
  assert.equal(readReturningSessionHint(storage), false);
  assert.equal(storage.values.has(AUTH_SESSION_HINT_KEY), false);
});

test("the hint dies with the sign-out attempt, and the failure still propagates", async () => {
  const successful = memoryStorage({
    [AUTH_SESSION_HINT_KEY]: AUTH_SESSION_HINT_VALUE,
  });
  await logoutAndClearReturningSessionHint(async () => undefined, successful);
  assert.equal(readReturningSessionHint(successful), false);

  // A failed provider call must not leave the hint standing. Sign-out clears
  // the server-readable identity cookie in a `finally` for exactly this
  // reason, and the hint is the other half of the same credential surface:
  // keeping it means the next document boots the provider on the hint alone,
  // an unresolved session comes back up, the cookie sync writes the
  // credential again, and the landing page's automatic hand-off walks the
  // visitor back into the product seconds after they pressed Sign out.
  const failed = memoryStorage({
    [AUTH_SESSION_HINT_KEY]: AUTH_SESSION_HINT_VALUE,
  });
  await assert.rejects(
    logoutAndClearReturningSessionHint(
      async () => {
        throw new Error("provider unavailable");
      },
      failed,
    ),
  );
  assert.equal(readReturningSessionHint(failed), false);
  assert.equal(failed.values.has(AUTH_SESSION_HINT_KEY), false);
  // And clearing an already-cleared hint stays a no-op.
  clearReturningSessionHint(failed);
  assert.equal(readReturningSessionHint(failed), false);
});

test("a provider sign-out that never answers still drops the hint, at the ceiling", async () => {
  // The defect this pins, and where the bound has to sit for it to be fixed.
  // The provider's sign-out is not written to give up on its own, so an
  // unanswered call left this `await` pending forever — and with it the
  // `finally` that clears the hint, and the `finally` one level out that
  // clears the identity cookie. The surface stayed disabled at "Signing
  // out…" for the life of the document, holding both credentials.
  //
  // Bounding the surface's own `await auth.logout()` instead would not have
  // fixed it: the surface would have left for the landing page while the hung
  // call still held the credentials, and the gate would have handed the
  // product straight back. So the ceiling wraps the provider call here, at
  // the innermost point, and the clears run before anything is reported out.
  const storage = memoryStorage({
    [AUTH_SESSION_HINT_KEY]: AUTH_SESSION_HINT_VALUE,
  });
  const ceiling = fakeSignOutCeiling();

  const unanswered = logoutAndClearReturningSessionHint(
    () => new Promise<void>(() => undefined),
    storage,
    ceiling.timer,
  );
  // Still held while the provider is merely slow: the ceiling is a bound on
  // waiting, not an eager teardown.
  assert.equal(readReturningSessionHint(storage), true);
  assert.deepEqual(ceiling.requested, [SIGN_OUT_CEILING_MS]);

  ceiling.elapse();

  // The failure reaches the surface, so it can settle and leave...
  await assert.rejects(unanswered, {
    message: SIGN_OUT_NOT_CONFIRMED_MESSAGE,
  });
  // ...and the credential is already gone by the time it does.
  assert.equal(readReturningSessionHint(storage), false);
  assert.equal(storage.values.has(AUTH_SESSION_HINT_KEY), false);
});

test("provider load failure resets intent so the next click can retry", () => {
  const requested = reduceAuthBootState(initialAuthBootState, {
    type: "login_intent",
  });
  assert.deepEqual(reduceAuthBootState(requested, { type: "provider_failed" }), {
    phase: "idle",
    loginRequested: false,
  });
});
