"use client";

import type { PublicRepackHeat } from "@packscout/contracts";
import { GlossaryHint } from "@/components/metrics/GlossaryHint.client";
import {
  presentRepackHeatDetails,
  REPACK_HEAT_INTERPRETATION,
} from "@/lib/repack-heat-presentation";
import { useDeadlineBoundRepackHeat } from "@/lib/repack-heat-deadline.client";
import { RepackHeatBadgeContent } from "./RepackHeatBadge";
import styles from "./RepackHeatDetails.module.css";

export function RepackHeatDetails({
  heat,
  headingId,
}: {
  readonly heat: PublicRepackHeat;
  readonly headingId: string;
}) {
  const effectiveHeat = useDeadlineBoundRepackHeat(heat);
  const presentation = presentRepackHeatDetails(effectiveHeat);

  return (
    <section aria-labelledby={headingId} className={styles.root}>
      <div className={styles.headingRow}>
        <span className={styles.headingGroup}>
          <h3 id={headingId}>Recent heat</h3>
          <GlossaryHint field="heat" />
        </span>
        <RepackHeatBadgeContent heat={effectiveHeat} />
      </div>

      <p className={styles.interpretation}>{REPACK_HEAT_INTERPRETATION}</p>

      {presentation.availability !== "current" ? (
        <div className={styles.unavailable}>
          <p>{presentation.message}</p>
          {presentation.availability === "expired" ? (
            <p className={styles.timing}>
              <time dateTime={presentation.lastCalculatedAt}>
                {presentation.lastCalculatedLabel}
              </time>
              <span className="sr-only">. </span>
              <span aria-hidden="true"> · </span>
              <time dateTime={presentation.expiredAt}>
                {presentation.expiredLabel}
              </time>
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <div>
              <span>Heat index</span>
              <strong>
                <span aria-hidden="true">{presentation.indexLabel}</span>
                <span className="sr-only">
                  {presentation.indexAccessibleLabel}
                </span>
              </strong>
            </div>
            <div>
              <span>Heat signal confidence</span>
              <strong>
                <span aria-hidden="true">{presentation.confidenceLabel}</span>
                <span className="sr-only">
                  {presentation.confidenceAccessibleLabel}
                </span>
              </strong>
            </div>
          </div>

          <p
            className={styles.provenance}
            data-simulated={presentation.badge.simulated ? "true" : "false"}
          >
            {presentation.provenanceLabel}
          </p>

          <div className={styles.windows}>
            <div>
              <span>Recent window</span>
              <strong>{presentation.currentWindow.pullCountLabel}</strong>
              <span className={styles.timeRange}>
                <time dateTime={presentation.currentWindow.startedAt}>
                  {presentation.currentWindow.startedLabel}
                </time>
                <span className="sr-only"> to </span>
                <span aria-hidden="true">–</span>
                <time dateTime={presentation.currentWindow.endedAt}>
                  {presentation.currentWindow.endedLabel}
                </time>
              </span>
            </div>
            <div>
              <span>Own baseline</span>
              <strong>{presentation.baselineWindow.pullCountLabel}</strong>
              <span className={styles.timeRange}>
                <time dateTime={presentation.baselineWindow.startedAt}>
                  {presentation.baselineWindow.startedLabel}
                </time>
                <span className="sr-only"> to </span>
                <span aria-hidden="true">–</span>
                <time dateTime={presentation.baselineWindow.endedAt}>
                  {presentation.baselineWindow.endedLabel}
                </time>
              </span>
            </div>
          </div>
          <p className={styles.sampleRequirement}>{presentation.sampleRequirementLabel}</p>

          <div className={styles.driverGroup}>
            <span>Heat drivers</span>
            <p>{presentation.driverExplanation}</p>
            <dl className={styles.drivers}>
              {presentation.drivers.map((driver) => (
                <div data-direction={driver.direction} key={driver.code}>
                  <dt>{driver.label}</dt>
                  <dd>
                    <strong aria-hidden="true">{driver.value}</strong>
                    <span aria-hidden="true">{driver.context}</span>
                    <span className="sr-only">{driver.accessibleLabel}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className={styles.componentGroup}>
            <span>Signal components</span>
            <dl className={styles.components}>
              {presentation.components.map((component) => (
                <div data-availability={component.availability} key={component.id}>
                  <dt>{component.label}</dt>
                  <dd>
                    <strong aria-hidden="true">{component.value}</strong>
                    <span aria-hidden="true">{component.context}</span>
                    <span className="sr-only">{component.accessibleLabel}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {presentation.limitations.length > 0 ? (
            <div className={styles.limitations}>
              <span>Signal limitations</span>
              <ul>
                {presentation.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className={styles.timing}>
            <time dateTime={presentation.calculatedAt}>{presentation.calculatedLabel}</time>
            <span className="sr-only">. </span>
            <span aria-hidden="true"> · </span>
            <time dateTime={presentation.expiresAt}>{presentation.expiresLabel}</time>
          </p>
        </>
      )}
    </section>
  );
}
