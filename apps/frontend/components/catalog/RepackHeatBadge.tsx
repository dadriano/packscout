"use client";

import type { PublicRepackHeat } from "@packscout/contracts";
import {
  presentRepackHeatBadge,
  REPACK_HEAT_INTERPRETATION,
} from "@/lib/repack-heat-presentation";
import { useDeadlineBoundRepackHeat } from "@/lib/repack-heat-deadline.client";
import styles from "./RepackHeatBadge.module.css";

export function RepackHeatBadgeContent({
  heat,
}: {
  readonly heat: PublicRepackHeat;
}) {
  const presentation = presentRepackHeatBadge(heat);

  return (
    <span
      className={styles.badge}
      data-simulated={presentation.simulated ? "true" : "false"}
      data-state={presentation.state}
      title={REPACK_HEAT_INTERPRETATION}
    >
      <span aria-hidden="true" className={styles.marker} />
      <span aria-hidden="true" className={styles.copy}>
        <strong>{presentation.label}</strong>
        {presentation.supportingLabel ? (
          <small>{presentation.supportingLabel}</small>
        ) : null}
      </span>
      <span className="sr-only">{presentation.accessibleLabel}</span>
    </span>
  );
}

export function RepackHeatBadge({ heat }: { readonly heat: PublicRepackHeat }) {
  const effectiveHeat = useDeadlineBoundRepackHeat(heat);
  return <RepackHeatBadgeContent heat={effectiveHeat} />;
}
