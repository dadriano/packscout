import { LANDING_COPY } from "@/lib/landing-content";
import { LandingAccessCta } from "./LandingAccessCta.client";
import styles from "./Landing.module.css";

/**
 * The public landing surface: the one page a stranger can reach during the
 * closed beta.
 *
 * It explains PackScout, states honestly that access is limited, and offers a
 * single access action. It is a server-renderable presentation with no data
 * dependencies at all — no catalog read, no authenticated read — so it works
 * while signed out and while the catalog read model is closed. The only
 * interactive piece is the access action, which consumes the existing
 * authentication context and preserves the intent-based provider boot.
 *
 * The surface is self-contained: closed-beta-access/007 renders it from the
 * root route for visitors who are not admitted, and `app/welcome/page.tsx`
 * keeps it addressable on its own. It brings no navigation, saved-item
 * affordances, or account controls of its own, so nothing on it points a
 * signed-out visitor at a surface they cannot use.
 */
export function LandingPage() {
  return (
    <section aria-labelledby="landing-heading" className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>{LANDING_COPY.eyebrow}</p>
        <h1
          className={styles.heading}
          data-route-heading
          id="landing-heading"
          tabIndex={-1}
        >
          {LANDING_COPY.headline}
        </h1>
        <p className={styles.lede}>{LANDING_COPY.lede}</p>
        <p className={styles.accessOutcome}>{LANDING_COPY.accessOutcome}</p>
        <LandingAccessCta />
      </header>

      <section
        aria-labelledby="landing-value-heading"
        className={styles.valueSection}
      >
        <h2 className={styles.sectionHeading} id="landing-value-heading">
          {LANDING_COPY.valueHeading}
        </h2>
        <ul className={styles.valueGrid}>
          {LANDING_COPY.valuePoints.map((point) => (
            <li className={styles.valueCard} key={point.title}>
              <h3 className={styles.valueTitle}>{point.title}</h3>
              <p className={styles.valueBody}>{point.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className={styles.disclaimer} role="note">
        {LANDING_COPY.disclaimer}
      </p>
    </section>
  );
}
