import Link from "next/link";
import {
  formatReadingTime,
  getLearnMetricDefinitions,
  type LearnGuide,
  type LearnSection,
} from "@/lib/learn-content";
import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";
import {
  getPackScoutEvWorkedExample,
  type PackScoutEvWorkedExample,
} from "@/lib/packscout-ev-examples";
import { ResponsiblePlayNotice } from "./ResponsiblePlayNotice";
import styles from "./Learn.module.css";

function WorkedExample({ example }: { example: PackScoutEvWorkedExample }) {
  return (
    <aside aria-label={example.title} className={styles.example}>
      <p className={styles.calloutLabel}>Worked example</p>
      <h3>{example.title}</h3>
      <p>{example.narrative}</p>
      <p className={styles.exampleGroupLabel}>Platform-documented scenario</p>
      <dl className={styles.exampleRows}>
        {example.inputRows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.exampleGroupLabel}>What PackScout shows</p>
      <dl className={styles.exampleRows}>
        {example.metricRows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p>{example.outcomeNote}</p>
    </aside>
  );
}

function ArticleSection({ section }: { section: LearnSection }) {
  const metricDefinitions = section.metricKeys
    ? getLearnMetricDefinitions(section.metricKeys)
    : [];

  return (
    <section className={styles.articleSection}>
      <h2>{section.heading}</h2>

      {section.paragraphs?.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}

      {metricDefinitions.length > 0 ? (
        <dl className={styles.metricDefinitions}>
          {metricDefinitions.map((metric) => (
            <div className={styles.metricDefinition} key={metric.key}>
              <dt>{metric.label}</dt>
              <dd>{metric.definition}.</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {section.checklist ? (
        <ul className={styles.evidenceList}>
          {section.checklist.map((item, index) => (
            <li key={item.title}>
              <span aria-hidden="true" className={styles.evidenceNumber}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {section.evExampleIds?.map((exampleId) => (
        <WorkedExample
          example={getPackScoutEvWorkedExample(exampleId)}
          key={exampleId}
        />
      ))}

      {section.callout ? (
        <aside
          aria-label={section.callout.label}
          className={styles.educationCallout}
        >
          <p className={styles.calloutLabel}>{section.callout.label}</p>
          {section.callout.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </aside>
      ) : null}
    </section>
  );
}

export function ArticleLayout({ guide }: { guide: LearnGuide }) {
  const descriptionId = `${guide.slug}-description`;

  return (
    <article
      aria-describedby={descriptionId}
      className={styles.article}
    >
      <nav aria-label="Guide navigation" className={styles.articleNavigation}>
        <Link className={styles.backLink} href="/learn">
          <span aria-hidden="true">←</span>
          Back to Learn
        </Link>
      </nav>

      <header className={styles.articleHeader}>
        <div className={styles.articleMeta}>
          <span>PackScout guide</span>
          <span aria-hidden="true">•</span>
          <span>{formatReadingTime(guide.readingTimeMinutes)}</span>
        </div>
        <h1 data-route-heading tabIndex={-1}>
          {guide.title}
        </h1>
        <p className={styles.articleDescription} id={descriptionId}>
          {guide.description}
        </p>

        {guide.slug === "expected-value" ? (
          <p className={styles.financialDisclaimer} role="note">
            {METRIC_TRUST_COPY.dashboardDisclaimer}
          </p>
        ) : null}
      </header>

      <div className={styles.articleBody}>
        {guide.sections.map((section) => (
          <ArticleSection key={section.heading} section={section} />
        ))}
      </div>

      <ResponsiblePlayNotice />

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
