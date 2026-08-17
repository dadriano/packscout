"use client";

import type { FocusEvent, KeyboardEvent } from "react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import type { PublicRepackHeat } from "@packscout/contracts";
import {
  CLOSED_GLOSSARY_HINT_STATE,
  GLOSSARY_OPEN_EVENT,
  positionGlossaryPanel,
  reduceGlossaryHintState,
} from "@/lib/glossary-hint.client";
import {
  presentRepackHeatBadge,
  REPACK_HEAT_INTERPRETATION,
  type RepackHeatBadgePresentation,
} from "@/lib/repack-heat-presentation";
import { useDeadlineBoundRepackHeat } from "@/lib/repack-heat-deadline.client";
import styles from "./RepackHeatBadge.module.css";

type RepackHeatBadgeVariant = "badge" | "icon";

function RepackHeatIconTooltip({
  presentation,
}: {
  readonly presentation: RepackHeatBadgePresentation;
}) {
  const reactId = useId();
  const instanceId = `heat-${reactId.replaceAll(":", "")}`;
  const tooltipId = `${instanceId}-tooltip`;
  const [state, dispatch] = useReducer(
    reduceGlossaryHintState,
    CLOSED_GLOSSARY_HINT_STATE,
  );
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const closeWhenAnotherHintOpens = (event: Event) => {
      const openedId = (event as CustomEvent<{ instanceId: string }>).detail
        ?.instanceId;
      if (openedId && openedId !== instanceId) {
        dispatch({ type: "another_hint_opened" });
      }
    };
    window.addEventListener(GLOSSARY_OPEN_EVENT, closeWhenAnotherHintOpens);
    return () => {
      window.removeEventListener(
        GLOSSARY_OPEN_EVENT,
        closeWhenAnotherHintOpens,
      );
    };
  }, [instanceId]);

  useEffect(() => {
    if (state.open) {
      window.dispatchEvent(
        new CustomEvent(GLOSSARY_OPEN_EVENT, { detail: { instanceId } }),
      );
    }
  }, [instanceId, state.open]);

  useLayoutEffect(() => {
    if (!state.open) return;

    function placePanel() {
      const root = rootRef.current;
      const panel = panelRef.current;
      if (!root || !panel) return;
      const trigger = root.getBoundingClientRect();
      const position = positionGlossaryPanel({
        align: "start",
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        trigger,
        panelWidth: panel.offsetWidth,
        panelHeight: panel.offsetHeight,
      });
      panel.style.insetInlineStart = `${position.left}px`;
      panel.style.insetBlockStart = `${position.top}px`;
      panel.style.visibility = "visible";
    }

    placePanel();
    window.addEventListener("resize", placePanel);
    window.addEventListener("scroll", placePanel, true);
    return () => {
      window.removeEventListener("resize", placePanel);
      window.removeEventListener("scroll", placePanel, true);
    };
  }, [state.open]);

  function handleBlur(event: FocusEvent<HTMLSpanElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      dispatch({ type: "focus_leave" });
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Escape" || !state.open) return;
    event.preventDefault();
    event.stopPropagation();
    dispatch({ type: "dismiss" });
    triggerRef.current?.focus();
  }

  return (
    <span
      className={styles.iconRoot}
      data-open={state.open ? "true" : "false"}
      data-simulated={presentation.simulated ? "true" : "false"}
      data-state={presentation.state}
      onBlur={handleBlur}
      onFocus={() => dispatch({ type: "focus_enter" })}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => dispatch({ type: "pointer_enter" })}
      onPointerLeave={() => dispatch({ type: "pointer_leave" })}
      ref={rootRef}
    >
      <button
        aria-controls={tooltipId}
        aria-describedby={state.open ? tooltipId : undefined}
        aria-expanded={state.open}
        aria-label={presentation.accessibleLabel}
        className={styles.iconTrigger}
        onClick={() => dispatch({ type: "toggle_pin" })}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true" className={styles.iconMarker} />
      </button>

      {state.open ? (
        <span
          className={styles.tooltip}
          id={tooltipId}
          ref={panelRef}
          role="tooltip"
        >
          <span className={styles.tooltipLabel}>{presentation.label}</span>
          {presentation.supportingLabel ? (
            <span className={styles.tooltipSupporting}>
              {presentation.supportingLabel}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function RepackHeatBadgeContent({
  heat,
  variant = "badge",
}: {
  readonly heat: PublicRepackHeat;
  readonly variant?: RepackHeatBadgeVariant;
}) {
  const presentation = presentRepackHeatBadge(heat);

  if (variant === "icon") {
    return <RepackHeatIconTooltip presentation={presentation} />;
  }

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

export function RepackHeatBadge({
  heat,
  variant = "badge",
}: {
  readonly heat: PublicRepackHeat;
  readonly variant?: RepackHeatBadgeVariant;
}) {
  const effectiveHeat = useDeadlineBoundRepackHeat(heat);
  return <RepackHeatBadgeContent heat={effectiveHeat} variant={variant} />;
}
