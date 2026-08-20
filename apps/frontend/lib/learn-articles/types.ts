import type { GlossaryFieldKey } from "../metric-vocabulary";
import type { PackScoutEvWorkedExampleId } from "../packscout-ev-examples";

export const LEARN_GUIDE_SLUGS = [
  "packscout-methodology",
  "what-is-a-repack",
  "expected-value",
  "repack-red-flags",
] as const;

export type LearnGuideSlug = (typeof LEARN_GUIDE_SLUGS)[number];

export type LearnArticleBlock =
  | Readonly<{
      type: "paragraph";
      text: string;
    }>
  | Readonly<{
      type: "subheading";
      text: string;
    }>
  | Readonly<{
      type: "list";
      style: "bulleted" | "numbered";
      items: readonly string[];
    }>
  | Readonly<{
      type: "formula";
      text: string;
    }>
  | Readonly<{
      type: "table";
      caption: string;
      columns: readonly string[];
      rows: readonly (readonly string[])[];
    }>;

export type LearnChecklistItem = Readonly<{
  title: string;
  body: string;
}>;

export type LearnSection = Readonly<{
  id: string;
  heading: string;
  blocks: readonly LearnArticleBlock[];
  /**
   * EV terms taught by this section render from the one canonical glossary
   * registry, so Learn and glossary hints can never diverge.
   */
  metricKeys?: readonly GlossaryFieldKey[];
  /** Numbered evidence checklists with short explanations. */
  checklist?: readonly LearnChecklistItem[];
  /** Worked examples rendered from the shared presentation-driven registry. */
  evExampleIds?: readonly PackScoutEvWorkedExampleId[];
  callout?: Readonly<{
    label: string;
    paragraphs: readonly string[];
  }>;
}>;

export type LearnGuide = Readonly<{
  slug: LearnGuideSlug;
  cardTitle: string;
  title: string;
  summary: string;
  readingTimeMinutes: number;
  intro: readonly string[];
  sections: readonly LearnSection[];
  showFinancialDisclaimer?: boolean;
  relatedLink: Readonly<{
    href: "/" | "/packs";
    label: string;
    description: string;
  }>;
}>;
