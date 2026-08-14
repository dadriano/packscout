import styles from "./CatalogState.module.css";
import {
  catalogUpdateMessage,
  type CatalogUpdateState,
} from "./catalog-state";

export function CatalogUpdateFeedback({
  update,
}: {
  update: CatalogUpdateState;
}) {
  const message = catalogUpdateMessage(update);
  if (!message) return null;

  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className={styles.updateFeedback}
      data-state={update.state}
      role="status"
    >
      {update.state === "updating" ? (
        <span aria-hidden="true" className={styles.updateDot} />
      ) : null}
      {message}
    </p>
  );
}
