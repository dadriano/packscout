import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_LINK_PURPOSES } from "@packscout/contracts";
import {
  DEFAULT_ADDRESS_MAX_PER_WINDOW,
  DEFAULT_INVITATION_LIFETIME_MS,
  DEFAULT_ISSUANCE_BLOCK_MS,
  DEFAULT_ISSUANCE_WINDOW_MS,
  DEFAULT_RESET_LIFETIME_MS,
  DEFAULT_SOURCE_MAX_PER_WINDOW,
  EMAIL_LINK_REDEMPTION_PATHS,
  EMAIL_LINK_TOKEN_SECRET_VARIABLE,
  assertEveryPurposeHasRedemptionPath,
  emailLinkPathFor,
  resolveEmailLinkTokenConfiguration,
  resolveEmailLinkTokenSecret,
} from "./configuration.ts";

test("defaults: a reset link lives one hour, an invitation seven days", () => {
  const configuration = resolveEmailLinkTokenConfiguration({});
  assert.equal(
    configuration.operator_password_reset.lifetimeMs,
    DEFAULT_RESET_LIFETIME_MS,
  );
  assert.equal(DEFAULT_RESET_LIFETIME_MS, 60 * 60_000);
  assert.equal(
    configuration.operator_invitation.lifetimeMs,
    DEFAULT_INVITATION_LIFETIME_MS,
  );
  assert.equal(DEFAULT_INVITATION_LIFETIME_MS, 7 * 24 * 60 * 60_000);
  for (const purpose of EMAIL_LINK_PURPOSES) {
    assert.deepEqual(configuration[purpose].rateLimit, {
      windowMs: DEFAULT_ISSUANCE_WINDOW_MS,
      blockMs: DEFAULT_ISSUANCE_BLOCK_MS,
      addressMaxPerWindow: DEFAULT_ADDRESS_MAX_PER_WINDOW,
      sourceMaxPerWindow: DEFAULT_SOURCE_MAX_PER_WINDOW,
    });
  }
});

test("configured values override per purpose without touching the other purpose", () => {
  const configuration = resolveEmailLinkTokenConfiguration({
    PACKSCOUT_EMAIL_LINK_RESET_LIFETIME_MS: "300000",
    PACKSCOUT_EMAIL_LINK_RESET_ADDRESS_MAX_PER_WINDOW: "2",
    PACKSCOUT_EMAIL_LINK_INVITATION_SOURCE_MAX_PER_WINDOW: "99",
    PACKSCOUT_EMAIL_LINK_ISSUANCE_WINDOW_MS: "60000",
  });
  assert.equal(configuration.operator_password_reset.lifetimeMs, 300_000);
  assert.equal(
    configuration.operator_password_reset.rateLimit.addressMaxPerWindow,
    2,
  );
  assert.equal(
    configuration.operator_invitation.lifetimeMs,
    DEFAULT_INVITATION_LIFETIME_MS,
  );
  assert.equal(configuration.operator_invitation.rateLimit.sourceMaxPerWindow, 99);
  assert.equal(configuration.operator_password_reset.rateLimit.windowMs, 60_000);
  assert.equal(configuration.operator_invitation.rateLimit.windowMs, 60_000);
});

test("a present but invalid setting fails closed instead of becoming a default", () => {
  for (const broken of [
    { PACKSCOUT_EMAIL_LINK_RESET_LIFETIME_MS: "soon" },
    { PACKSCOUT_EMAIL_LINK_RESET_LIFETIME_MS: "0" },
    { PACKSCOUT_EMAIL_LINK_RESET_LIFETIME_MS: "-1" },
    { PACKSCOUT_EMAIL_LINK_INVITATION_LIFETIME_MS: "1.5" },
    { PACKSCOUT_EMAIL_LINK_ISSUANCE_WINDOW_MS: "1" },
    { PACKSCOUT_EMAIL_LINK_RESET_ADDRESS_MAX_PER_WINDOW: "0" },
    { PACKSCOUT_EMAIL_LINK_INVITATION_ADDRESS_MAX_PER_WINDOW: "many" },
  ]) {
    assert.throws(
      () => resolveEmailLinkTokenConfiguration(broken),
      RangeError,
      JSON.stringify(broken),
    );
  }
});

test("the secret resolves as configured and never as a default", () => {
  assert.equal(resolveEmailLinkTokenSecret({}), null);
  assert.equal(
    resolveEmailLinkTokenSecret({ [EMAIL_LINK_TOKEN_SECRET_VARIABLE]: "  " }),
    null,
  );
  assert.equal(
    resolveEmailLinkTokenSecret({
      [EMAIL_LINK_TOKEN_SECRET_VARIABLE]: "configured-secret-value",
    }),
    "configured-secret-value",
  );
});

test("every purpose has a rooted redemption path and an opaque token parameter", () => {
  assertEveryPurposeHasRedemptionPath();
  assert.equal(
    EMAIL_LINK_REDEMPTION_PATHS.operator_password_reset,
    "/reset-password",
  );
  assert.equal(
    EMAIL_LINK_REDEMPTION_PATHS.operator_invitation,
    "/accept-invitation",
  );
  const presented = `${"a".repeat(22)}.${"B".repeat(43)}`;
  assert.equal(
    emailLinkPathFor("operator_password_reset", presented),
    `/reset-password#token=${presented}`,
  );
  assert.equal(
    emailLinkPathFor("operator_invitation", presented),
    `/accept-invitation#token=${presented}`,
  );
});

test("a one-time credential never rides in the query string of a mailed link", () => {
  // A token in the query string reaches every server access log the request
  // touches, and — the admin serves `Referrer-Policy: same-origin` — travels
  // in the `Referer` of every same-origin asset and API request the
  // redemption screen makes. The fragment never leaves the browser.
  const presented = `${"a".repeat(22)}.${"B".repeat(43)}`;
  for (const purpose of EMAIL_LINK_PURPOSES) {
    const url = new URL(
      emailLinkPathFor(purpose, presented),
      "https://admin.packscout.test",
    );
    assert.equal(url.pathname, EMAIL_LINK_REDEMPTION_PATHS[purpose]);
    assert.equal(url.search, "", `${purpose} carries no query string`);
    assert.equal(url.searchParams.get("token"), null);
    assert.equal(url.hash, `#token=${presented}`);
    // Nothing but the fragment holds the token.
    assert.equal(
      `${url.origin}${url.pathname}${url.search}`.includes(presented),
      false,
    );
  }
});
