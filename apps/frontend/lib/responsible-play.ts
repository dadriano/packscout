/**
 * The single approved responsible-play resource block (task
 * buyback-adjusted-ev/011). Every public Learn and glossary education surface
 * renders this block through this module; no surface maintains its own
 * helpline copy, so the contact can never diverge between pages.
 *
 * RELEASE CHECK — helpline contact verified on 2026-08-19 against the
 * official National Council on Problem Gambling sources:
 *
 * - https://www.ncpgambling.org/news/1-800-my-reset-announcement/
 *   (2026-01-29: NCPG adopted 1-800-MY-RESET / 1-800-697-3738 as the National
 *   Problem Gambling Helpline number after a court ruling ended NCPG's use of
 *   1-800-GAMBLER on 2025-09-29; the former 1-800-522-4700 remains an active
 *   legacy access point.)
 * - https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/
 *   (current official forms: Call 1-800-MY-RESET, Text 1-800-MY-RESET, Chat
 *   Online; the helpline is available 24/7, free and confidential.)
 * - https://www.ncpgambling.org/1-800-my-reset-national-problem-gambling-helpline-faq/
 *
 * The national helpline number has changed twice in recent years, so no
 * stored document number — including the one in PackScout_Methodology.docx —
 * is permanent source truth. Re-verify the current contact at
 * ncpgambling.org before every release, then update this block, the
 * `verifiedOn` date, and the pinned release-check test in
 * `responsible-play.test.ts` together.
 */

export type ResponsiblePlayHelpline = Readonly<{
  organization: string;
  name: string;
  /** The three official contact forms: call, text, and online chat. */
  callLabel: string;
  callHref: `tel:${string}`;
  textLabel: string;
  textHref: `sms:${string}`;
  chatLabel: string;
  chatHref: `https://${string}`;
  phoneDisplay: string;
  phoneNumericDisplay: string;
  availability: string;
  /** The date the contact above was last verified against ncpgambling.org. */
  verifiedOn: string;
}>;

export type ResponsiblePlayResource = Readonly<{
  heading: string;
  paragraphs: readonly string[];
  helpline: ResponsiblePlayHelpline;
}>;

export const RESPONSIBLE_PLAY_RESOURCE = Object.freeze({
  heading: "Responsible play",
  paragraphs: Object.freeze([
    "Opening a repack involves risk and can result in financial loss. Even a favorable Gross EV is an average across many outcomes — any individual pack can lose money, and past outcomes do not guarantee future results.",
    "If you or someone you know has a gambling problem, help is available 24/7 — free and confidential.",
  ]),
  helpline: Object.freeze({
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
  }),
} as const satisfies ResponsiblePlayResource);
