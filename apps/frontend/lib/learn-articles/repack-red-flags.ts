import type { LearnGuide } from "./types";

export const REPACK_RED_FLAGS_GUIDE = {
  slug: "repack-red-flags",
  cardTitle: "Repack Red Flags",
  title: "Repack Red Flags: How to Spot a Scam or Rigged Product Before You Buy",
  summary:
    "Eight practical checks for spotting opaque, misleading, or suspicious repacks—and identifying operators that give buyers clear, verifiable terms.",
  readingTimeMinutes: 7,
  intro: [
    "The repack market has no regulator, no licensing body, and no standardized disclosure requirements. Anyone with a card show table and a heat sealer can build one and call it whatever they want. That doesn't mean every repack is a scam, but it does mean the burden of figuring out which ones are legitimate falls entirely on the buyer.",
    "Most of the warning signs are checkable in a few minutes, before you ever pull out a card. What follows is a specific, practical list of the things worth looking for, and why each one matters.",
  ],
  sections: [
    {
      id: "no-published-checklist",
      heading: "Red Flag 1: No Published Checklist",
      blocks: [
        {
          type: "paragraph",
          text: "A legitimate repack operator publishes a full checklist of what could be inside the product, often with a running or \"living\" version that updates as cards get pulled and replaced. If a seller can't or won't tell you what's actually in the pool, there's no way to know whether the chase cards advertised on the box art were ever really part of the product.",
        },
        {
          type: "paragraph",
          text: "Vague marketing copy like \"loaded with hits\" or \"chance at a graded rookie\" with no actual list behind it isn't a checklist. It's a promise with nothing to back it up, and the absence of a real one is the single biggest tell in this whole category.",
        },
      ],
    },
    {
      id: "no-disclosed-odds",
      heading: "Red Flag 2: No Disclosed Odds",
      blocks: [
        {
          type: "paragraph",
          text: "A checklist tells you what's possible. Odds tell you how likely each outcome actually is, and without them, you can't calculate expected value or make an informed decision about whether the price is fair.",
        },
        {
          type: "paragraph",
          text: "Some operators disclose exact pull rates per tier. Others give a reasonable estimate based on print run and known distribution. Either is workable. What's not workable is a seller who refuses to give you any sense of the odds at all, especially when they're happy to advertise the ceiling (\"chance at a $2,000 grail card!\") while staying silent on how remote that chance actually is.",
        },
      ],
    },
    {
      id: "ceiling-only-marketing",
      heading: "Red Flag 3: Marketing That Leans Entirely on the Ceiling",
      blocks: [
        {
          type: "paragraph",
          text: "Watch how a repack is actually marketed. If every ad, every product photo, and every piece of copy centers on the single best possible pull and never mentions the realistic, typical outcome, that's a design choice, not an accident.",
        },
        {
          type: "paragraph",
          text: "Legitimate operators will show you what an average pack looks like alongside the rare big hit, because they're selling a real product with a real distribution of outcomes. Sellers relying purely on grail-card marketing are selling you on a fantasy outcome that happens to almost nobody, and they know it.",
        },
      ],
    },
    {
      id: "no-condition-disclosure",
      heading: "Red Flag 4: Raw Cards With No Condition Disclosure",
      blocks: [
        {
          type: "paragraph",
          text: "One of the uglier and less discussed practices in the lower end of this market involves raw, ungraded cards that get pulled specifically because they have condition issues, a corner ding, surface wear, print defects, that would keep them from grading well. Those cards get quietly slipped into repacks and marketed as chase-worthy inclusions, when in reality they were culled from someone else's grading submission precisely because they weren't good enough to make the cut.",
        },
        {
          type: "paragraph",
          text: "A legitimate operator will disclose known condition issues on raw cards, or at minimum describe their sourcing process for how raw cards enter the pool. A seller who says nothing about condition, and whose raw card photos are conveniently low-resolution or taken at odd angles that obscure corners and edges, is worth extra scrutiny.",
        },
      ],
    },
    {
      id: "fake-urgency",
      heading: "Red Flag 5: Fake Urgency and Manufactured Scarcity",
      blocks: [
        {
          type: "paragraph",
          text: "\"Only 3 left,\" countdown timers, \"selling out fast,\" and similar pressure tactics are borrowed straight from low-end e-commerce, and they show up constantly in weaker repack marketing. The goal is to get you to buy before you've had time to check the checklist, the odds, or the seller's track record.",
        },
        {
          type: "paragraph",
          text: "Legitimate scarcity exists in this hobby. A limited print run of a genuinely well-curated product selling out is normal. But artificial urgency stacked on top of vague marketing and no disclosed odds is a combination almost always designed to short-circuit due diligence rather than reflect real demand.",
        },
      ],
    },
    {
      id: "no-verifiable-track-record",
      heading: "Red Flag 6: No Verifiable Track Record",
      blocks: [
        {
          type: "paragraph",
          text: "Anyone can post screenshots of big pulls. What's harder to fake is a consistent, verifiable history: a business that's been operating for a meaningful length of time, reviews across multiple independent platforms rather than just curated testimonials on their own site, and visible activity in places like Reddit's collecting communities or established Discord servers where actual buyers, not the seller's own marketing account, are discussing their experience.",
        },
        {
          type: "paragraph",
          text: "Be especially cautious of brand-new accounts or storefronts with no history, generic stock photography instead of real product photos, and reviews that all appeared within a tight window, a common sign of purchased or incentivized reviews rather than organic ones.",
        },
      ],
    },
    {
      id: "no-clear-policy",
      heading: "Red Flag 7: No Clear Return, Authenticity, or Grading Policy",
      blocks: [
        {
          type: "paragraph",
          text: "A repack is, among other things, a bet on the authenticity and condition of everything inside it. Legitimate operators are upfront about what happens if a card arrives damaged in shipping, what their policy is if a card turns out to be miscut, altered, or otherwise problematic, and whether they stand behind the authenticity of any autographed or memorabilia cards included.",
        },
        {
          type: "paragraph",
          text: "A seller with no visible policy on any of this, and no clear way to contact them if something goes wrong, is putting all of the risk on you with none of the recourse.",
        },
      ],
    },
    {
      id: "price-does-not-match-checklist",
      heading: "Red Flag 8: Price That Doesn't Match the Checklist",
      blocks: [
        {
          type: "paragraph",
          text: "Even when a checklist and odds are published, it's worth doing the basic math rather than taking the price at face value. If a $150 repack's published checklist, run through even a rough expected value calculation, comes out clearly disconnected from the price, either wildly overpriced relative to the actual odds, or suspiciously generous in a way that doesn't make business sense, something is off. Sellers occasionally publish checklists that look good on paper but include far more copies of the low-value common tier than the odds suggest, effectively padding the math in their favor without changing the sticker price.",
        },
        {
          type: "paragraph",
          text: "Running the numbers takes a few minutes and is the single best way to convert marketing claims into an actual, comparable figure.",
        },
      ],
    },
    {
      id: "legitimate-operator",
      heading: "What a Legitimate Repack Operator Actually Looks Like",
      blocks: [
        {
          type: "paragraph",
          text: "It's worth stating the positive case plainly, since the goal isn't to make every repack look suspicious. A trustworthy operator typically has most or all of the following: a full, current checklist, disclosed or reasonably estimated odds, transparent sourcing (they'll tell you where the cards come from, not just that they're \"hand-selected\"), condition disclosure on raw cards, a real business history with reviews spread across independent platforms, and a clear policy for damage, authenticity, or grading disputes.",
        },
        {
          type: "paragraph",
          text: "None of that guarantees a great pull. It does mean you're buying a real product with real, checkable terms, rather than a black box built on marketing copy.",
        },
      ],
    },
    {
      id: "pre-purchase-checklist",
      heading: "A Quick Pre-Purchase Checklist",
      blocks: [
        {
          type: "paragraph",
          text: "Before buying any repack, it takes about five minutes to check the following:",
        },
        {
          type: "list",
          style: "numbered",
          items: [
            "Is there a full, published checklist, and does it look current?",
            "Are the odds disclosed, or at least reasonably estimable?",
            "Does the marketing show typical outcomes, not just the best-case grail card?",
            "Is there any disclosure of condition on raw cards?",
            "Is the seller pressuring you with urgency tactics instead of letting the product speak for itself?",
            "Does the seller have a real, independently verifiable track record?",
            "Is there a clear return, authenticity, or damage policy?",
            "Does a rough expected value calculation match what the price implies?",
          ],
        },
        {
          type: "paragraph",
          text: "A seller who clears most of these isn't guaranteed to give you a good pull, since variance is the nature of the product. But they're giving you a fair, informed shot at one, which is really all due diligence can promise in a category built around chance.",
        },
      ],
    },
    {
      id: "bottom-line",
      heading: "The Bottom Line",
      blocks: [
        {
          type: "paragraph",
          text: "None of these red flags exist in isolation, and finding one doesn't automatically mean a repack is a scam. What matters is the pattern. A seller with no checklist, no odds, heavy urgency marketing, and no verifiable history is telling you something, even if they never say it directly. The good news is that every one of these checks takes minutes, not hours, and a market with no regulator rewards buyers who do their own homework before the sale rather than after.",
        },
      ],
    },
  ],
  relatedLink: {
    href: "/packs",
    label: "Review repacks in All Repacks",
    description:
      "Compare supported prices, estimates, inventory signals, and vendor listings side by side.",
  },
} as const satisfies LearnGuide;
