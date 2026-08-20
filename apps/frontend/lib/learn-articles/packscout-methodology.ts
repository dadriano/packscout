import type { LearnGuide } from "./types";

export const PACKSCOUT_METHODOLOGY_GUIDE = {
  slug: "packscout-methodology",
  cardTitle: "PackScout Methodology",
  title: "PackScout Methodology",
  summary:
    "Learn how PackScout standardizes platform-provided repack data into dynamically updated metrics, including Gross EV, buyback, inventory, odds, chases, and pulls—and where the methodology's limits begin.",
  readingTimeMinutes: 6,
  intro: [
    "How PackScout sources, standardizes, and presents repack data.",
    "PackScout makes repacks easier to understand and compare across platforms. We surface data provided by repack platforms, standardize it into a common format, and update it dynamically as the underlying data changes.",
    "At launch, PackScout does not independently value the cards or collectibles inside a repack. Values, inventory, odds, buyback terms, and other underlying product data come from the platforms themselves.",
  ],
  sections: [
    {
      id: "repack",
      heading: "Repack",
      blocks: [
        {
          type: "paragraph",
          text: "A repack is a bundle of cards assembled by a seller and resold as a single sealed unit for a set price. Unlike a factory box from a manufacturer, a repack is built from the secondary market — cards pulled from other packs, bought in bulk, or acquired individually, then reassembled into something new.",
        },
        {
          type: "paragraph",
          text: "Most repacks combine a base of lower-value cards with a chance at something better — a graded card, an autograph, a rare parallel, or an older card that would otherwise be hard to find. That chance at a hit is central to the product: buyers are paying for odds, not just cards.",
        },
        {
          type: "paragraph",
          text: "Repacks aren't limited to sports cards. Pokémon and other trading card games are a significant part of the repack market, often mixing raw cards, graded cards, and sealed packs within the same product.",
        },
      ],
    },
    {
      id: "gross-ev",
      heading: "Gross EV",
      blocks: [
        {
          type: "paragraph",
          text: "Expected value, or EV, represents the average value of a pack across all possible outcomes. PackScout displays two Gross EV metrics.",
        },
        { type: "subheading", text: "Gross EV $" },
        {
          type: "paragraph",
          text: "Gross EV $ is the expected value of a pack in dollars, including the platform's buyback percentage.",
        },
        {
          type: "paragraph",
          text: "Example: If the expected value of the underlying outcomes is $100 and the platform offers an 85% buyback, Gross EV $ is $85.",
        },
        { type: "subheading", text: "Gross EV %" },
        {
          type: "paragraph",
          text: "Gross EV % expresses Gross EV $ as a percentage of the pack price.",
        },
        {
          type: "paragraph",
          text: "Example: If a pack costs $100 and has a Gross EV $ of $85, Gross EV % is 85%.",
        },
        {
          type: "paragraph",
          text: "Gross EV is calculated using data provided by the repack platform and updates dynamically as the underlying pack data changes. Expected value is an average across possible outcomes. It does not predict the result of an individual pack.",
        },
      ],
    },
    {
      id: "buyback-percentage",
      heading: "Buyback %",
      blocks: [
        {
          type: "paragraph",
          text: "Buyback % is the percentage of a pull's stated value that a platform offers if the user chooses to sell it back rather than take possession of the collectible.",
        },
        {
          type: "paragraph",
          text: "Example: A card with a stated value of $100 and an 85% buyback would have a buyback value of $85.",
        },
        {
          type: "paragraph",
          text: "Buyback terms vary by platform and product.",
        },
      ],
    },
    {
      id: "pack-price",
      heading: "Pack Price",
      blocks: [
        {
          type: "paragraph",
          text: "Pack Price is the price to open or purchase one pack. Unless otherwise stated, PackScout uses the current price displayed by the platform.",
        },
      ],
    },
    {
      id: "inventory",
      heading: "Inventory",
      blocks: [
        {
          type: "paragraph",
          text: "Inventory is the pool of possible outcomes within a repack. For finite-inventory products, inventory changes as packs are opened and collectibles are pulled. Where the platform makes this information available, PackScout updates inventory dynamically.",
        },
      ],
    },
    {
      id: "remaining-inventory",
      heading: "Remaining Inventory",
      blocks: [
        {
          type: "paragraph",
          text: "Remaining Inventory is the portion of a pack's original inventory that has not yet been pulled.",
        },
        {
          type: "paragraph",
          text: "This can be important when evaluating a finite-inventory repack. As outcomes are removed, the composition of the remaining pool can change. PackScout displays remaining inventory when it can be determined from the data provided by the platform.",
        },
      ],
    },
    {
      id: "odds",
      heading: "Odds",
      blocks: [
        {
          type: "paragraph",
          text: "Odds represent the probability of receiving a particular outcome or category of outcomes.",
        },
        {
          type: "paragraph",
          text: "PackScout surfaces odds provided by the platform or calculates them when they can be directly determined from platform-provided inventory. If odds cannot be reliably determined from the available data, we do not estimate them.",
        },
      ],
    },
    {
      id: "chase",
      heading: "Chase",
      blocks: [
        {
          type: "paragraph",
          text: "Chase refers to a particularly desirable or high-value outcome within a pack.",
        },
        {
          type: "paragraph",
          text: "A chase identifies a notable possible outcome. It does not indicate the probability of pulling that outcome unless odds are also shown.",
        },
      ],
    },
    {
      id: "pull",
      heading: "Pull",
      blocks: [
        {
          type: "paragraph",
          text: "A Pull is the outcome of an individual pack opening. PackScout surfaces pull data provided by the platform.",
        },
      ],
    },
    {
      id: "recent-pulls",
      heading: "Recent Pulls",
      blocks: [
        {
          type: "paragraph",
          text: "Recent Pulls are the most recently reported outcomes for a pack. They show what has recently been opened and, for finite-inventory products, can help provide context around what remains.",
        },
        {
          type: "paragraph",
          text: "Recent Pulls do not predict the outcome of the next pack.",
        },
      ],
    },
    {
      id: "dynamic-data",
      heading: "Dynamic Data",
      blocks: [
        {
          type: "paragraph",
          text: "Repack products can change quickly. Prices may change, inventory can be depleted, chase cards can be pulled, and the composition of a finite pool can shift with every opening.",
        },
        {
          type: "paragraph",
          text: "PackScout updates its data as new information becomes available from each platform so the metrics shown reflect the latest available state of the pack.",
        },
      ],
    },
    {
      id: "unavailable",
      heading: "Unavailable",
      blocks: [
        {
          type: "paragraph",
          text: "When PackScout does not have enough platform data to reliably display or calculate a metric, we show Unavailable.",
        },
        {
          type: "paragraph",
          text: "Unavailable does not mean zero. It means the necessary data is not available. We would rather show no number than fill a gap with an unsupported assumption.",
        },
      ],
    },
    {
      id: "data-sources",
      heading: "Data Sources",
      blocks: [
        {
          type: "paragraph",
          text: "PackScout currently sources underlying repack data directly from the platforms we cover.",
        },
        { type: "paragraph", text: "At launch, this includes:" },
        {
          type: "list",
          style: "bulleted",
          items: [
            "Courtyard",
            "Collector Crypt",
            "Phygitals",
            "ClutchPacks",
            "GameStop",
            "Beezie",
            "Trove",
            "Stadium Vault",
          ],
        },
        {
          type: "paragraph",
          text: "PackScout standardizes this information so products from different platforms can be viewed and compared using a common set of metrics.",
        },
        {
          type: "paragraph",
          text: "PackScout does not currently use independent collectible sales data or proprietary collectible valuations when calculating Gross EV.",
        },
      ],
    },
    {
      id: "important-limitations",
      heading: "Important Limitations",
      blocks: [
        {
          type: "paragraph",
          text: "PackScout relies on information published or provided by repack platforms. We do not independently verify every underlying value, inventory position, probability, or other data point.",
        },
        {
          type: "paragraph",
          text: "Platform data can change and may occasionally be incomplete or delayed. PackScout updates its metrics as new underlying data becomes available.",
        },
        {
          type: "paragraph",
          text: "Expected value is a statistical measure across possible outcomes. It is not a prediction of an individual pack, and actual results can vary significantly.",
        },
        {
          type: "paragraph",
          text: "PackScout organizes and analyzes repack data to make products easier to understand and compare. We do not guarantee the accuracy of platform-provided information, individual outcomes, collectible values, or profitability.",
        },
      ],
    },
    {
      id: "not-financial-advice",
      heading: "Not Financial Advice",
      blocks: [
        {
          type: "paragraph",
          text: "PackScout provides data and calculations to help users understand and compare repack products. Nothing on PackScout constitutes financial, investment, or gambling advice, and no metric — including Gross EV — is a recommendation to purchase any pack or product.",
        },
        {
          type: "paragraph",
          text: "Expected value is a statistical average across possible outcomes, not a prediction of any individual result. Actual outcomes can vary significantly and may result in the loss of some or all money spent. Users are solely responsible for their own purchasing decisions.",
        },
      ],
    },
    {
      id: "responsible-play",
      heading: "Responsible Play",
      blocks: [
        {
          type: "paragraph",
          text: "Opening a repack involves risk and can result in financial loss. Even a favorable Gross EV reflects an average across many outcomes — any individual pack can lose money, and past outcomes do not guarantee future results.",
        },
        {
          type: "paragraph",
          text: "If you or someone you know has a gambling problem, help is available 24/7. Call or text 1-800-522-4700, or visit ncpgambling.org.",
        },
      ],
    },
  ],
  relatedLink: {
    href: "/",
    label: "Explore PackScout",
    description:
      "See PackScout's standardized repack metrics in context on the dashboard.",
  },
} as const satisfies LearnGuide;
