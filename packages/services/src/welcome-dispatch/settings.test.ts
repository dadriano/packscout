import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveWelcomeDispatchSettings,
  WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE,
  WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE,
  WELCOME_EMAIL_ENABLED_VARIABLE,
} from "./settings.ts";

const TOKEN = "welcome-dispatch-integration-token-0001";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values };
}

test("unset means enabled and unconfigured, with no problems", () => {
  const settings = resolveWelcomeDispatchSettings(env({}));
  assert.equal(settings.enabled, true);
  assert.equal(settings.integration, null);
  assert.deepEqual(settings.problems, []);
});

test("the explicit off switch disables the welcome kind and nothing else resolves differently", () => {
  for (const value of ["0", "false", "off", "no", " OFF "]) {
    const settings = resolveWelcomeDispatchSettings(
      env({
        [WELCOME_EMAIL_ENABLED_VARIABLE]: value,
        [WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE]: "https://backend.example.com",
        [WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE]: TOKEN,
      }),
    );
    assert.equal(settings.enabled, false);
    // The integration stays resolved: the switch governs the kind, not the
    // surface, so flipping it back on needs no other change.
    assert.deepEqual(settings.integration, {
      baseUrl: "https://backend.example.com",
      token: TOKEN,
    });
    assert.deepEqual(settings.problems, []);
  }
});

test("a typo on the switch stays enabled, visibly — never silently off", () => {
  const settings = resolveWelcomeDispatchSettings(
    env({ [WELCOME_EMAIL_ENABLED_VARIABLE]: "nope" }),
  );
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.problems, ["WELCOME_EMAIL_ENABLED_INVALID"]);
});

test("the integration requires a safe secret and an https (or local cleartext) origin", () => {
  const short = resolveWelcomeDispatchSettings(
    env({
      [WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE]: "https://backend.example.com",
      [WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE]: "short",
    }),
  );
  assert.equal(short.integration, null);
  assert.deepEqual(short.problems, [
    "WELCOME_DISPATCH_DIRECTORY_TOKEN_INVALID",
  ]);

  const cleartext = resolveWelcomeDispatchSettings(
    env({
      [WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE]: "http://backend.example.com",
      [WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE]: TOKEN,
    }),
  );
  assert.equal(cleartext.integration, null);
  assert.deepEqual(cleartext.problems, [
    "WELCOME_DISPATCH_DIRECTORY_URL_INVALID",
  ]);

  const local = resolveWelcomeDispatchSettings(
    env({
      [WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE]: "http://localhost:3210/ignored-path",
      [WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE]: TOKEN,
    }),
  );
  // Origin only: a configured path never leaks into request URLs.
  assert.deepEqual(local.integration, {
    baseUrl: "http://localhost:3210",
    token: TOKEN,
  });
});

test("a garbled origin resolves to unconfigured rather than throwing", () => {
  const settings = resolveWelcomeDispatchSettings(
    env({
      [WELCOME_DISPATCH_DIRECTORY_URL_VARIABLE]: "not a url",
      [WELCOME_DISPATCH_DIRECTORY_TOKEN_VARIABLE]: TOKEN,
    }),
  );
  assert.equal(settings.integration, null);
  assert.deepEqual(settings.problems, [
    "WELCOME_DISPATCH_DIRECTORY_URL_INVALID",
  ]);
});
