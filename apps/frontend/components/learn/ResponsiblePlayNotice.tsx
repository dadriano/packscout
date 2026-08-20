import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";
import { RESPONSIBLE_PLAY_RESOURCE } from "@/lib/responsible-play";
import styles from "./Learn.module.css";

/**
 * The one responsible-play block shared by every Learn and glossary education
 * surface. All copy and the verified helpline contact come from the
 * responsible-play content registry; this component only renders it.
 */
export function ResponsiblePlayNotice() {
  const { heading, paragraphs, helpline } = RESPONSIBLE_PLAY_RESOURCE;
  return (
    <aside aria-label={heading} className={styles.responsiblePlay}>
      <p className={styles.calloutLabel}>{heading}</p>
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <p className={styles.responsibleContact}>
        <a href={helpline.callHref}>{helpline.callLabel}</a>
        <span aria-hidden="true"> · </span>
        <a href={helpline.textHref}>{helpline.textLabel}</a>
        <span aria-hidden="true"> · </span>
        <a href={helpline.chatHref} rel="noreferrer noopener" target="_blank">
          {helpline.chatLabel}
        </a>
      </p>
      <p className={styles.responsibleMeta}>
        {`${helpline.name} — ${helpline.organization}. ${METRIC_TRUST_COPY.adviceLine}.`}
      </p>
    </aside>
  );
}
