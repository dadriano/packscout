import type { Metadata } from "next";

/**
 * Every word the public landing surface says, in one place.
 *
 * The landing page is the only product surface a stranger can reach during
 * the closed beta, so its copy carries two obligations at once: explain what
 * PackScout is in the product's own voice without overclaiming, and state
 * honestly what signing in does — allowlisted people go straight in, everyone
 * else is placed in review. The copy lives here, apart from the markup, so
 * those obligations can be asserted by tests instead of re-read by hand on
 * every edit.
 *
 * Nothing in this module reads catalog data or touches authentication. It is
 * plain, browser-safe content that renders identically while signed out and
 * while the catalog read model is closed.
 */

export type LandingValuePoint = Readonly<{
  title: string;
  body: string;
}>;

export const LANDING_COPY = Object.freeze({
  eyebrow: "PackScout · Closed beta",
  headline: "Scout the repack market before you spend",
  lede:
    "PackScout is a market-intelligence dashboard for collectible repacks. " +
    "It lines up listings from multiple repack providers side by side and " +
    "puts an estimated expected value — with the reasoning behind it — next " +
    "to every pack.",
  betaStatement:
    "PackScout is in closed beta, so access is limited right now. Signing " +
    "in is the access request: if your email or wallet address is on the " +
    "allowlist you are in right away, and everyone else is placed in review.",
  valueHeading: "What PackScout does",
  valuePoints: Object.freeze([
    Object.freeze({
      title: "Estimated EV beside every price",
      body:
        "Each repack listing carries an estimated expected value with its " +
        "assumptions in the open. EV is a long-run estimate — it never " +
        "predicts the contents or outcome of a single rip.",
    }),
    Object.freeze({
      title: "One dashboard across providers",
      body:
        "Compare repacks from multiple providers in one place, with filters " +
        "that narrow the field and data freshness you can check at a glance " +
        "instead of tab-hopping storefronts.",
    }),
    Object.freeze({
      title: "Methodology in the open",
      body:
        "Plain-language guides document where the data comes from, how the " +
        "estimates are built, and the red flags worth a closer look — so you " +
        "can judge the numbers, not just read them.",
    }),
  ]) satisfies readonly LandingValuePoint[],
  accessHeading: "How access works during the beta",
  accessLede:
    "There is no waitlist form and no email capture. The sign-in itself is " +
    "the access request.",
  accessSteps: Object.freeze([
    "Choose Sign in. PackScout uses one hosted wallet-or-social sign-in — " +
      "the same one the product uses everywhere.",
    "If your email or wallet address is on the beta allowlist, you are in " +
      "immediately.",
    "If it is not, your request is placed in review, and you are in as soon " +
      "as it is approved.",
  ]),
  disclaimer:
    "PackScout provides educational market context, not financial advice. " +
    "EV figures are estimates. Opening a repack involves risk and can " +
    "result in financial loss.",
});

const LANDING_TITLE = "PackScout — Repack market intelligence for collectors";

const LANDING_DESCRIPTION =
  "PackScout compares collectible repack listings across providers with " +
  "estimated expected value and transparent methodology. Now in closed " +
  "beta — sign in to request access.";

/**
 * Metadata for whichever route renders the landing surface.
 *
 * The landing page is the marketing surface, so it stays indexable (no
 * robots directive here — making the gated surfaces non-indexable belongs to
 * closed-beta-access/007) and carries its own absolute title rather than the
 * layout's "%s · PackScout" template, which would double the product name.
 * Social metadata is limited to text on purpose: the repository has no
 * social-card image asset today, and pointing crawlers at the 128px favicon
 * would be worse than letting them fall back to the page itself.
 */
export const LANDING_METADATA: Metadata = {
  title: { absolute: LANDING_TITLE },
  description: LANDING_DESCRIPTION,
  openGraph: {
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    siteName: "PackScout",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
  },
};
