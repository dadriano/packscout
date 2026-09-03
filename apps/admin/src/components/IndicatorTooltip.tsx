import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StatusBadge, type StatusTone } from "./StatusBadge";

interface IndicatorTooltipProps {
  readonly label: string;
  readonly description: string;
  readonly tone?: StatusTone;
  readonly className?: string;
}

/** A readable explanation available to pointer, keyboard, and touch users. */
export function IndicatorTooltip({ label, description, tone, className = "" }: IndicatorTooltipProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const open = (hovered || focused || pinned) && !dismissed;

  function enter() {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    setHovered(true);
    setDismissed(false);
  }

  function leave() {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    // Let the pointer cross the small gap into the explanation without hiding it.
    closeTimer.current = setTimeout(() => setHovered(false), 120);
  }

  useEffect(() => () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!trigger.current || !tooltip.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const content = tooltip.current.getBoundingClientRect();
      const edge = 12;
      const gap = 8;
      const below = anchor.bottom + gap;
      const top = below + content.height <= window.innerHeight - edge
        ? below
        : Math.max(edge, anchor.top - content.height - gap);
      const left = Math.max(edge, Math.min(
        anchor.left,
        window.innerWidth - content.width - edge,
      ));
      setPosition({ top, left });
    }
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, description]);

  useEffect(() => {
    if (!open) return;
    function dismiss() {
      setPinned(false);
      setDismissed(true);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node &&
          !trigger.current?.contains(event.target) &&
          !tooltip.current?.contains(event.target)) dismiss();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`admin-indicator ${className}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") enter(); }}
        onPointerLeave={leave}
        onFocus={() => { setFocused(true); setDismissed(false); }}
        onBlur={() => { setFocused(false); setPinned(false); }}
        onClick={() => {
          setPinned(!pinned);
          setDismissed(pinned);
        }}
      >
        {tone ? <StatusBadge label={label} tone={tone} /> : <span className="admin-indicator__label">{label}</span>}
        <span className="admin-indicator__hint" aria-hidden="true">?</span>
      </button>
      {open ? createPortal(
        <span
          ref={tooltip}
          id={id}
          role="tooltip"
          className="admin-indicator-tooltip"
          style={position}
          onPointerEnter={enter}
          onPointerLeave={leave}
        >
          {description}
        </span>,
        document.body,
      ) : null}
    </>
  );
}
