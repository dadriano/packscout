"use client";

import Link from "next/link";
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import {
  CLOSED_GLOSSARY_HINT_STATE,
  GLOSSARY_OPEN_EVENT,
  positionGlossaryPanel,
  reduceGlossaryHintState,
} from "@/lib/glossary-hint.client";
import {
  getGlossaryDefinition,
  type GlossaryDefinition,
  type GlossaryFieldKey,
} from "@/lib/metric-vocabulary";
import styles from "./GlossaryHint.module.css";

type GlossaryHintProps = Readonly<{
  field: GlossaryFieldKey;
  align?: "start" | "end";
  content?: Pick<GlossaryDefinition, "label" | "definition" | "learnHref">;
  details?: readonly string[];
  detailsHeading?: string;
  trigger?: ReactNode;
  triggerAriaLabel?: string;
  triggerClassName?: string;
}>;

export function GlossaryHint({
  field,
  align = "start",
  content,
  details = [],
  detailsHeading = "Confidence limitations",
  trigger,
  triggerAriaLabel,
  triggerClassName,
}: GlossaryHintProps) {
  const definition = content ?? getGlossaryDefinition(field);
  const reactId = useId();
  const instanceId = `glossary-${reactId.replaceAll(":", "")}`;
  const panelId = `${instanceId}-definition`;
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
        align,
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
  }, [align, state.open]);

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
      className={styles.root}
      data-align={align}
      data-open={state.open ? "true" : "false"}
      onBlur={handleBlur}
      onFocus={() => dispatch({ type: "focus_enter" })}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => dispatch({ type: "pointer_enter" })}
      onPointerLeave={() => dispatch({ type: "pointer_leave" })}
      ref={rootRef}
    >
      <button
        aria-controls={panelId}
        aria-describedby={state.open ? panelId : undefined}
        aria-expanded={state.open}
        aria-label={
          triggerAriaLabel ??
          (details.length > 0
            ? `About ${definition.label} and its limitations`
            : `About ${definition.label}`)
        }
        className={triggerClassName ?? styles.trigger}
        onClick={() => dispatch({ type: "toggle_pin" })}
        ref={triggerRef}
        type="button"
      >
        {trigger ?? "i"}
      </button>

      {state.open ? (
        <span
          className={styles.panel}
          id={panelId}
          ref={panelRef}
          role="note"
        >
          <span className={styles.heading}>{definition.label}</span>
          <span className={styles.definition}>{definition.definition}</span>
          {details.length > 0 ? (
            <span className={styles.details}>
              <span className={styles.detailsHeading}>{detailsHeading}</span>
              <span className={styles.detailsList} role="list">
                {details.map((detail) => (
                  <span
                    className={styles.detail}
                    key={detail}
                    role="listitem"
                  >
                    {detail}
                  </span>
                ))}
              </span>
            </span>
          ) : null}
          {definition.learnHref ? (
            <Link className={styles.learnLink} href={definition.learnHref}>
              Learn how EV is estimated
              <span aria-hidden="true"> →</span>
            </Link>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
