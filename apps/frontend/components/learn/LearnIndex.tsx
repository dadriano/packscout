import Link from "next/link";
import {
  formatReadingTime,
  learnGuideHref,
  PACKSCOUT_EV_METHOD,
  type LearnGuide,
} from "@/lib/learn-content";
import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";
import { ResponsiblePlayNotice } from "./ResponsiblePlayNotice";
import styles from "./Learn.module.css";

export function LearnIndex({ guides }: { guides: readonly LearnGuide[] }) {
  const [methodology, ...articles] = guides;

  return (
    <section className={styles.indexPage} aria-labelledby="learn-heading">
      <header className={styles.indexHeader}>
        <p className={styles.eyebrow}>PackScout field guides</p>
        <h1
          className={styles.indexHeading}
          data-route-heading
          id="learn-heading"
          tabIndex={-1}
        >
          Know before you rip
        </h1>
        <p className={styles.indexIntro}>
          Four complete articles explain how repacks work, how to read expected
          value, which warning signs deserve a closer look, and where
          PackScout&apos;s data comes from.
        </p>
      </header>

      {methodology ? (
        <article
          aria-labelledby="featured-methodology-heading"
          className={styles.methodSection}
        >
          <div className={styles.featuredMeta}>
            <span>{formatReadingTime(methodology.readingTimeMinutes)}</span>
          </div>
          <h2
            className={styles.methodHeading}
            id="featured-methodology-heading"
          >
            {methodology.cardTitle}
          </h2>
          <p className={styles.methodSummary}>{methodology.summary}</p>
          <Link
            className={styles.methodLink}
            href={learnGuideHref(methodology.slug)}
          >
            Read the full methodology
            <span aria-hidden="true">→</span>
          </Link>
        </article>
      ) : null}

      <section
        aria-labelledby="packscout-ev-method-heading"
        className={styles.methodSection}
      >
        <p className={styles.eyebrow}>{PACKSCOUT_EV_METHOD.title}</p>
        <h2 className={styles.methodHeading} id="packscout-ev-method-heading">
          How PackScout EV works
        </h2>
        <p className={styles.methodSummary}>{PACKSCOUT_EV_METHOD.summary}</p>

        <ol className={styles.methodList}>
          {PACKSCOUT_EV_METHOD.points.map((point, index) => (
            <li key={point.title}>
              <span aria-hidden="true" className={styles.methodNumber}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className={styles.methodDisclaimer} role="note">
          {PACKSCOUT_EV_METHOD.disclaimer}{" "}
          {METRIC_TRUST_COPY.adviceLine}.
        </p>

        <Link
          className={styles.methodLink}
          href={PACKSCOUT_EV_METHOD.learnMoreHref}
        >
          {PACKSCOUT_EV_METHOD.learnMoreLabel}
          <span aria-hidden="true">→</span>
        </Link>
      </section>

      <ol className={styles.guideGrid} aria-label="PackScout articles">
        {articles.map((guide, index) => (
          <li className={styles.guideItem} key={guide.slug}>
            <article
              aria-labelledby={`learn-guide-${guide.slug}-heading`}
              className={styles.guideCard}
            >
              <div className={styles.guideMeta}>
                <span aria-hidden="true" className={styles.guideNumber}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{formatReadingTime(guide.readingTimeMinutes)}</span>
              </div>
              <h2
                className={styles.guideTitle}
                id={`learn-guide-${guide.slug}-heading`}
              >
                {guide.cardTitle}
              </h2>
              <p className={styles.guideDescription}>{guide.summary}</p>
              <Link
                className={styles.guideAction}
                href={learnGuideHref(guide.slug)}
              >
                Read full article: {guide.cardTitle}
                <span aria-hidden="true">↗</span>
              </Link>
            </article>
          </li>
        ))}
      </ol>

      <ResponsiblePlayNotice />

      <p className={styles.indexNote}>
        Educational content only. PackScout education is vendor-neutral and
        stays available while catalog data is loading or unavailable.
      </p>
    </section>
  );
}
