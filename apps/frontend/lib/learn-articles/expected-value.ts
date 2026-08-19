import type { LearnGuide } from "./types";

export const EXPECTED_VALUE_GUIDE = {
  slug: "expected-value",
  cardTitle: "What Is EV (Expected Value)?",
  title:
    "What Is EV (Expected Value): A Complete Guide, With a Deep Dive Into Repack EV",
  summary:
    "Learn how expected value works, why variance still matters, and how to calculate and use EV when comparing sports card repacks.",
  readingTimeMinutes: 9,
  intro: [],
  sections: [
    {
      id: "introduction",
      heading: "Introduction",
      blocks: [
        {
          type: "paragraph",
          text: "EV, short for expected value, is one of the most useful concepts in probability, and one of the most misunderstood. People use it constantly in gambling, insurance, investing, and increasingly in the sports card and collectibles market, but a surprising number of them are using the term loosely without ever running the actual math.",
        },
        {
          type: "paragraph",
          text: "Expected value is not a guess, a vibe, or a gut feeling about whether something is \"worth it.\" It's a precise, calculable number that tells you the average outcome of a decision if you could repeat it an infinite number of times. Once you understand how to calculate it, and just as importantly, what it doesn't tell you, you'll find it useful for evaluating almost any decision that involves uncertainty and a price tag. That includes, as we'll get into, deciding whether a given sports card repack is actually worth buying.",
        },
      ],
    },
    {
      id: "basic-definition",
      heading: "The Basic Definition of Expected Value",
      blocks: [
        {
          type: "paragraph",
          text: "At its core, expected value is a weighted average. You take every possible outcome of a given decision, multiply each outcome by the probability of it happening, and add the results together.",
        },
        {
          type: "paragraph",
          text: "The formula looks like this:",
        },
        {
          type: "formula",
          text: "EV = (Probability of Outcome 1 × Value of Outcome 1) + (Probability of Outcome 2 × Value of Outcome 2) + ... for every possible outcome",
        },
        {
          type: "paragraph",
          text: "If you're evaluating a purchase or a bet, you typically subtract the cost to arrive at net expected value:",
        },
        {
          type: "formula",
          text: "Net EV = (Sum of all probability-weighted outcomes) − Cost",
        },
        {
          type: "paragraph",
          text: "A positive net EV means that, on average, over many repetitions, the decision pays off. A negative net EV means that, on average, it loses money. That word \"average\" is doing a lot of work in that sentence, and we'll come back to why.",
        },
      ],
    },
    {
      id: "coin-flip-example",
      heading: "Example 1: A Simple Coin Flip Bet",
      blocks: [
        {
          type: "paragraph",
          text: "Say a friend offers you a bet: flip a coin, and if it lands on heads, you win $150. If it lands on tails, you lose your $100 stake.",
        },
        {
          type: "paragraph",
          text: "The math:",
        },
        {
          type: "list",
          style: "bulleted",
          items: [
            "Probability of heads: 50%, value: +$150",
            "Probability of tails: 50%, value: −$100",
          ],
        },
        {
          type: "formula",
          text: "EV = (0.5 × 150) + (0.5 × -100) = 75 − 50 = +$25",
        },
        {
          type: "paragraph",
          text: "Take that bet as many times as your friend is willing to offer it. Any individual flip could go either way, but across a large number of flips, you'd expect to come out $25 ahead per flip on average. That's a clearly positive-EV bet, even though any single flip carries real risk.",
        },
      ],
    },
    {
      id: "roulette-example",
      heading: "Example 2: Roulette and the House Edge",
      blocks: [
        {
          type: "paragraph",
          text: "Casino games are built specifically to produce negative EV for the player, which is exactly how casinos stay in business. Take a single number bet on American roulette. It pays 35 to 1, and there are 38 numbers on the wheel (1 through 36, plus 0 and 00).",
        },
        {
          type: "paragraph",
          text: "Your probability of winning is 1 in 38. If you bet $1:",
        },
        {
          type: "formula",
          text: "EV = (1/38 × $35) + (37/38 × -$1) = 0.921 − 0.974 = −$0.053",
        },
        {
          type: "paragraph",
          text: "Every dollar bet on a single number loses about 5.3 cents in expected value. Play enough spins and that edge grinds you down with mathematical certainty, no matter how many times you feel like you're \"due\" for a win.",
        },
      ],
    },
    {
      id: "insurance-example",
      heading: "Example 3: Insurance, Viewed From the Other Side of the Table",
      blocks: [
        {
          type: "paragraph",
          text: "Expected value isn't just for gambling. Insurance companies price policies almost entirely around EV, just from the seller's perspective instead of the buyer's.",
        },
        {
          type: "paragraph",
          text: "An insurer calculating a policy premium estimates the probability of a claim, multiplies it by the expected payout size, and adds a margin for profit and overhead. The insurer wants the EV of the policy to be positive for itself across its entire pool of customers, which necessarily means it's negative EV for any individual policyholder in a strict mathematical sense. That's not a flaw in the system. Insurance exists to transfer risk, not to generate profit for the buyer, and most people are happy to accept a small negative EV in exchange for protection against a catastrophic loss they couldn't otherwise absorb.",
        },
      ],
    },
    {
      id: "poker-example",
      heading: "Example 4: Poker and Skill-Based EV",
      blocks: [
        {
          type: "paragraph",
          text: "Poker offers one of the clearest illustrations of why EV matters more than any single result. A skilled player can make a mathematically correct, positive-EV decision, get unlucky, and still lose the hand. Over a large enough sample of hands, though, a player who consistently makes positive-EV decisions will come out ahead, while a player making negative-EV decisions will lose money even if they get lucky in the short term.",
        },
        {
          type: "paragraph",
          text: "This is why serious poker players talk about EV constantly and results comparatively rarely. A single tournament outcome is mostly noise. Decision quality, measured in EV, is signal.",
        },
      ],
    },
    {
      id: "ev-and-variance",
      heading: "Why EV Alone Isn't the Whole Story",
      blocks: [
        {
          type: "paragraph",
          text: "A common mistake is treating EV as the only number that matters. It isn't. Two decisions can have identical EV and wildly different risk profiles.",
        },
        {
          type: "paragraph",
          text: "Consider two options: a guaranteed payment of $50, versus a coin flip for $0 or $100. Both have an EV of $50. Most people, faced with that choice, take the guaranteed $50 anyway, because they're not purely EV-maximizing machines. They also care about variance, which is the spread of possible outcomes around that average.",
        },
        {
          type: "paragraph",
          text: "This distinction matters enormously once you start applying EV to real purchases, including collectibles, where variance can mean the difference between a fun $40 gamble and a purchase that quietly drains your bankroll over dozens of attempts even though the math technically favors you in the long run.",
        },
      ],
    },
    {
      id: "repack-ev",
      heading: "What Is EV in Sports Card Repacks?",
      blocks: [
        {
          type: "paragraph",
          text: "Now to the part collectors actually search for: what EV means in the context of a repack.",
        },
        {
          type: "paragraph",
          text: "A repack, for anyone unfamiliar, is a sealed, curated pack of cards assembled from the secondary market and resold at a fixed price, with the appeal being a shot at pulling something more valuable than what you paid. Repack EV applies the exact same math covered above to that purchase decision.",
        },
        {
          type: "paragraph",
          text: "To calculate the expected value of a repack, you need three things: the full checklist of possible cards, the odds or pull rate for each card (or at least a reasonable estimate), and current market value for each card on that checklist.",
        },
        {
          type: "paragraph",
          text: "Repack EV formula:",
        },
        {
          type: "formula",
          text: "EV = Σ (Probability of pulling card X × Market value of card X) − Cost of the repack",
        },
        {
          type: "subheading",
          text: "A Worked Example",
        },
        {
          type: "paragraph",
          text: "Imagine a $100 repack with a published checklist of 500 possible cards. To keep the math manageable, group the checklist into simplified tiers:",
        },
        {
          type: "table",
          caption: "Simplified tiers",
          columns: [
            "Tier",
            "Odds",
            "Cards in Tier",
            "Value per Card",
            "Contribution to EV",
          ],
          rows: [
            ["Common", "90%", "450", "$2", "$1.80"],
            ["Mid-tier hit", "8%", "40", "$25", "$2.00"],
            ["Chase card", "1.8%", "9", "$150", "$2.70"],
            ["Grail card", "0.2%", "1", "$2,000", "$4.00"],
          ],
        },
        {
          type: "paragraph",
          text: "Add up the contribution column: $1.80 + $2.00 + $2.70 + $4.00 = $10.50 in expected value per pack, before subtracting the $100 cost.",
        },
        {
          type: "formula",
          text: "Net EV = $10.50 − $100 = −$89.50",
        },
        {
          type: "paragraph",
          text: "That number will look shocking to anyone new to this exercise, but it's actually normal. Almost every repack, and almost every sealed hobby product of any kind, carries negative EV. The seller has to cover their acquisition cost, packaging, marketing, platform fees, and profit margin, all of which comes out of that same pool of value. Negative EV doesn't automatically mean a repack is a scam. It means you're paying for the experience and the chance, the same way you pay for a lottery ticket or a slot machine pull, not for a mathematically favorable transaction.",
        },
        {
          type: "subheading",
          text: "Why Repack EV Is Harder to Calculate Than It Looks",
        },
        {
          type: "paragraph",
          text: "Unlike a coin flip or a roulette wheel, repack EV depends on inputs that are frequently incomplete, outdated, or simply unavailable to the buyer.",
        },
        {
          type: "paragraph",
          text: "Checklist accuracy. A published checklist is only useful if it's actually accurate and current. Some operators maintain \"living\" checklists that update as cards are pulled and replaced, while others publish a static list that may not reflect what's actually left in the pool by the time you buy.",
        },
        {
          type: "paragraph",
          text: "Market value volatility. Card values move constantly, sometimes significantly within days of a player's performance, a rookie season, or a broader market shift. An EV calculation is only as good as the pricing data behind it, and stale comps will throw the whole number off.",
        },
        {
          type: "paragraph",
          text: "Grading and liquidation costs. The market value listed for a card is usually its raw or graded resale value, not what you'll actually net after grading fees, shipping, marketplace commissions, and the time it takes to sell. Real, realized EV is almost always lower than theoretical EV calculated off sticker prices.",
        },
        {
          type: "paragraph",
          text: "Undisclosed odds. Plenty of repacks simply don't publish odds at all, which makes a genuine EV calculation impossible and should be treated as a red flag in itself.",
        },
        {
          type: "subheading",
          text: "How to Use Repack EV as a Buyer",
        },
        {
          type: "paragraph",
          text: "Despite all of that, running even a rough EV estimate before buying a repack is worth the ten minutes it takes, for a few reasons.",
        },
        {
          type: "paragraph",
          text: "It tells you what you're actually paying for. A repack priced at $100 with an EV of $80 is a very different product from one priced at $100 with an EV of $15, even though both might advertise a similar chase card on the box.",
        },
        {
          type: "paragraph",
          text: "It lets you compare products honestly. EV gives you a standardized way to compare a $50 repack against a $200 one, or a repack against a factory-sealed hobby box, instead of relying on marketing copy and box art.",
        },
        {
          type: "paragraph",
          text: "It resets expectations around variance. Understanding that a repack is negative EV by design, in the same way a lottery ticket or a casino game is, reframes the purchase as entertainment spending rather than an investment. That's a healthier and more accurate way to approach the category, and it matches how thoughtful collectors already think about sealed wax generally.",
        },
      ],
    },
    {
      id: "bottom-line",
      heading: "The Bottom Line",
      blocks: [
        {
          type: "paragraph",
          text: "Expected value is a simple idea with real teeth once you actually run the numbers. Whether you're evaluating a coin flip bet, an insurance policy, a poker decision, or a sports card repack, the same formula applies: multiply each possible outcome by its probability, add them up, and subtract what you paid. Almost everything built for entertainment, from casino games to lottery tickets to repacks, is intentionally structured with negative EV, and knowing that number doesn't take the fun out of the purchase. It just makes sure you're going in with your eyes open, treating the chase for what it actually is rather than what the marketing wants it to look like.",
        },
      ],
    },
  ],
  showFinancialDisclaimer: true,
  relatedLink: {
    href: "/",
    label: "Explore EV on Dashboard",
    description:
      "Compare supported long-run estimates and catalog context on the PackScout Dashboard.",
  },
} as const satisfies LearnGuide;
