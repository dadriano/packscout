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

test("successful logout clears the hint while failed logout preserves it", async () => {
  const successful = memoryStorage({
    [AUTH_SESSION_HINT_KEY]: AUTH_SESSION_HINT_VALUE,
  });
  await logoutAndClearReturningSessionHint(async () => undefined, successful);
  assert.equal(readReturningSessionHint(successful), false);

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
  assert.equal(readReturningSessionHint(failed), true);
  clearReturningSessionHint(failed);
  assert.equal(readReturningSessionHint(failed), false);
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
