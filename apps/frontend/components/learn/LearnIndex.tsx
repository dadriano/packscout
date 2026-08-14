import Link from "next/link";
import {
  formatReadingTime,
  type LearnGuide,
} from "@/lib/learn-content";
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
          Understand the pack before you open it.
        </h1>
        <p className={styles.indexIntro}>
          Three practical guides to repacks, long-run value estimates, and the
          evidence worth checking before you follow a vendor listing.
        </p>
      </header>

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

      <p className={styles.indexNote}>
        PackScout education is vendor-neutral and stays available while
        catalog data is loading or unavailable.
      </p>
    </section>
  );
}
