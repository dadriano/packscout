import assert from "node:assert/strict";
import { test } from "node:test";
import { RESPONSIBLE_PLAY_RESOURCE } from "./responsible-play";

/**
 * RELEASE CHECK — do not "fix" this test by only editing the expected
 * values.
 *
 * The National Problem Gambling Helpline number is not permanent source
 * truth: it moved off 1-800-522-4700 to 1-800-GAMBLER, lost 1-800-GAMBLER by
 * court order on 2025-09-29, and became 1-800-MY-RESET on 2026-01-29. This
 * test pins the exact contact so any silent edit fails loudly. When it fails
 * (or whenever a release is being certified), a human re-verifies the current
 * official contact at https://www.ncpgambling.org, updates
 * `lib/responsible-play.ts` and this pin together, and records the new
 * `verifiedOn` date. Last verified 2026-08-19 against:
 * - https://www.ncpgambling.org/news/1-800-my-reset-announcement/
 * - https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/
 */
test("pins the verified official NCPG helpline contact (release check)", () => {
  assert.deepEqual(RESPONSIBLE_PLAY_RESOURCE.helpline, {
    organization: "National Council on Problem Gambling",
    name: "National Problem Gambling Helpline",
    callLabel: "Call 1-800-MY-RESET (1-800-697-3738)",
    callHref: "tel:+18006973738",
    textLabel: "Text 1-800-MY-RESET",
    textHref: "sms:+18006973738",
    chatLabel: "Chat online at 1800myreset.org",
    chatHref: "https://www.1800myreset.org",
    phoneDisplay: "1-800-MY-RESET",
    phoneNumericDisplay: "1-800-697-3738",
    availability: "Available 24/7 — free and confidential",
    verifiedOn: "2026-08-19",
  });
});

test("keeps the approved responsible-play framing in one shared block", () => {
  assert.equal(RESPONSIBLE_PLAY_RESOURCE.heading, "Responsible play");
  assert.equal(RESPONSIBLE_PLAY_RESOURCE.paragraphs.length, 2);
  const [risk, help] = RESPONSIBLE_PLAY_RESOURCE.paragraphs;
  // Risk framing from the approved methodology: EV is an average, one pack
  // can lose money, and past outcomes never guarantee future results.
  assert.match(risk ?? "", /risk and can result in financial loss/);
  assert.match(risk ?? "", /average across many outcomes/);
  assert.match(risk ?? "", /past outcomes do not guarantee future results/);
  assert.match(help ?? "", /available 24\/7/);
  assert.match(help ?? "", /free and confidential/);
});

test("the helpline hrefs stay aligned with the displayed numbers", () => {
  const { helpline } = RESPONSIBLE_PLAY_RESOURCE;
  const digits = helpline.phoneNumericDisplay.replaceAll("-", "");
  assert.equal(helpline.callHref, `tel:+1${digits.slice(1)}`);
  assert.equal(helpline.textHref, `sms:+1${digits.slice(1)}`);
  assert.ok(helpline.callLabel.includes(helpline.phoneDisplay));
  assert.ok(helpline.callLabel.includes(helpline.phoneNumericDisplay));
  assert.ok(helpline.textLabel.includes(helpline.phoneDisplay));
  assert.ok(helpline.chatHref.startsWith("https://"));
});
