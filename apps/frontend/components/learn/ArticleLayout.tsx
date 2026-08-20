import Link from "next/link";
import {
  formatReadingTime,
  type LearnArticleBlock,
  type LearnGuide,
  type LearnSection,
} from "@/lib/learn-content";
import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";
import styles from "./Learn.module.css";

function ArticleBlock({
  block,
  sectionId,
  position,
}: {
  block: LearnArticleBlock;
  sectionId: string;
  position: number;
}) {
  if (block.type === "paragraph") {
    return <p className={styles.articleParagraph}>{block.text}</p>;
  }

  if (block.type === "subheading") {
    return <h3 className={styles.articleSubheading}>{block.text}</h3>;
  }

  if (block.type === "list") {
    const List = block.style === "numbered" ? "ol" : "ul";
    return (
      <List className={styles.articleList}>
        {block.items.map((item, index) => (
          <li key={`${sectionId}-${position}-${index}`}>{item}</li>
        ))}
      </List>
    );
  }

  if (block.type === "formula") {
    return (
      <div className={styles.formula} role="note">
        <span className={styles.formulaLabel}>Formula</span>
        <p>{block.text}</p>
      </div>
    );
  }

  return (
    <div
      aria-label={`${block.caption} table`}
      className={styles.articleTableRegion}
      role="region"
      tabIndex={0}
    >
      <table className={styles.articleTable}>
        <caption>{block.caption}</caption>
        <thead>
          <tr>
            {block.columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${sectionId}-row-${rowIndex}`}>
              {row.map((cell, cellIndex) =>
                cellIndex === 0 ? (
                  <th key={`${sectionId}-${rowIndex}-${cellIndex}`} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={`${sectionId}-${rowIndex}-${cellIndex}`}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArticleSection({ section }: { section: LearnSection }) {
  return (
    <section className={styles.articleSection}>
      <h2 id={section.id}>{section.heading}</h2>
      {section.blocks.map((block, index) => (
        <ArticleBlock
          block={block}
          key={`${section.id}-${index}`}
          position={index}
          sectionId={section.id}
        />
      ))}
    </section>
  );
}

export function ArticleLayout({ guide }: { guide: LearnGuide }) {
  const descriptionId = `${guide.slug}-description`;

  return (
    <article aria-describedby={descriptionId} className={styles.article}>
      <nav aria-label="Article navigation" className={styles.articleNavigation}>
        <Link className={styles.backLink} href="/learn">
          <span aria-hidden="true">←</span>
          Back to Learn
        </Link>
      </nav>

      <header className={styles.articleHeader}>
        <div className={styles.articleMeta}>
          <span>PackScout article</span>
          <span aria-hidden="true">•</span>
          <span>{formatReadingTime(guide.readingTimeMinutes)}</span>
        </div>
        <h1 data-route-heading tabIndex={-1}>
          {guide.title}
        </h1>
        <p className={styles.articleDescription} id={descriptionId}>
          {guide.summary}
        </p>

        {guide.showFinancialDisclaimer ? (
          <p className={styles.financialDisclaimer} role="note">
            {METRIC_TRUST_COPY.dashboardDisclaimer}
          </p>
        ) : null}
      </header>

      {guide.intro.length > 0 ? (
        <div className={styles.articleIntro}>
          {guide.intro.map((paragraph, index) => (
            <p key={`${guide.slug}-intro-${index}`}>{paragraph}</p>
          ))}
        </div>
      ) : null}

      <div className={styles.articleBody}>
        {guide.sections.map((section) => (
          <ArticleSection key={section.id} section={section} />
        ))}
      </div>

      <footer className={styles.relatedPanel}>
        <p className={styles.calloutLabel}>Continue on Dashboard</p>
        <h2>{guide.relatedLink.label}</h2>
        <p>{guide.relatedLink.description}</p>
        <Link className={styles.relatedLink} href={guide.relatedLink.href}>
          {guide.relatedLink.label}
          <span aria-hidden="true">→</span>
        </Link>
      </footer>
    </article>
  );
}
