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

export type LearnSection = Readonly<{
  id: string;
  heading: string;
  blocks: readonly LearnArticleBlock[];
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
