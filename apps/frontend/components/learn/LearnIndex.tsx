import Link from "next/link";
import {
  formatReadingTime,
  PACKSCOUT_EV_METHOD,
  type LearnGuide,
} from "@/lib/learn-content";
import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";
import { ResponsiblePlayNotice } from "./ResponsiblePlayNotice";
import styles from "./Learn.module.css";

export function LearnIndex({ guides }: { guides: readonly LearnGuide[] }) {
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
          Know before you Rip
        </h1>
        <p className={styles.indexIntro}>
          Three practical guides to repacks, long-run value estimates, and the
          evidence worth checking before you follow a vendor listing.
        </p>
      </header>

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

      <ol className={styles.guideGrid} aria-label="PackScout guides">
        {guides.map((guide, index) => (
          <li className={styles.guideItem} key={guide.slug}>
            <article className={styles.guideCard}>
              <div className={styles.guideMeta}>
                <span aria-hidden="true" className={styles.guideNumber}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{formatReadingTime(guide.readingTimeMinutes)}</span>
              </div>
              <h2 className={styles.guideTitle}>{guide.title}</h2>
              <p className={styles.guideDescription}>{guide.description}</p>
              <Link
                className={styles.guideAction}
                href={`/learn/${guide.slug}`}
              >
                Read {guide.title}
                <span aria-hidden="true">↗</span>
              </Link>
            </article>
          </li>
        ))}
      </ol>

      <ResponsiblePlayNotice />

      <p className={styles.indexNote}>
        PackScout education is vendor-neutral and stays available while
        catalog data is loading or unavailable.
      </p>
    </section>
  );
}
