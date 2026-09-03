export const GLOSSARY_OPEN_EVENT = "packscout:glossary-open" as const;

/** Viewport margin the panel never crosses, in CSS pixels. */
export const GLOSSARY_PANEL_MARGIN = 16;
/** Air between the trigger and the panel; the caret and hover bridge live here. */
export const GLOSSARY_PANEL_GAP = 10;
/** Closest the caret center may sit to either inline edge of the panel. */
export const GLOSSARY_CARET_INSET = 14;

export type GlossaryHintState = Readonly<{
  open: boolean;
  pinned: boolean;
  pointerWithin: boolean;
  focusWithin: boolean;
  dismissed: boolean;
}>;

export type GlossaryHintAction =
  | { readonly type: "pointer_enter" }
  | { readonly type: "pointer_leave" }
  | { readonly type: "focus_enter" }
  | { readonly type: "focus_leave" }
  | { readonly type: "toggle_pin" }
  | { readonly type: "dismiss" }
  | { readonly type: "another_hint_opened" };

export const CLOSED_GLOSSARY_HINT_STATE: GlossaryHintState = Object.freeze({
  open: false,
  pinned: false,
  pointerWithin: false,
  focusWithin: false,
  dismissed: false,
});

export type GlossaryPanelAlign = "start" | "center" | "end";

export type GlossaryPanelPlacement = "below" | "above";

export type GlossaryPanelPosition = Readonly<{
  left: number;
  top: number;
  placement: GlossaryPanelPlacement;
  /** Distance from the panel's inline-start edge to the caret center. */
  caretOffset: number;
}>;

export type GlossaryPanelPositionInput = Readonly<{
  align: GlossaryPanelAlign;
  viewportWidth: number;
  viewportHeight: number;
  trigger: Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
  }>;
  panelWidth: number;
  panelHeight: number;
  margin?: number;
  gap?: number;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

/**
 * Places the panel in viewport coordinates: centered on the trigger by
 * default (or hung from its start or end edge), kept inside the viewport
 * margin, and below the trigger unless only the space above fits. The caret
 * offset keeps pointing at the trigger's center after a viewport edge pushes
 * the panel sideways.
 */
export function positionGlossaryPanel({
  align,
  viewportWidth,
  viewportHeight,
  trigger,
  panelWidth,
  panelHeight,
  margin = GLOSSARY_PANEL_MARGIN,
  gap = GLOSSARY_PANEL_GAP,
}: GlossaryPanelPositionInput): GlossaryPanelPosition {
  const boundedWidth = Math.min(panelWidth, Math.max(0, viewportWidth - margin * 2));
  const triggerCenter = (trigger.left + trigger.right) / 2;
  const preferredLeft =
    align === "end"
      ? trigger.right - boundedWidth
      : align === "center"
        ? triggerCenter - boundedWidth / 2
        : trigger.left;
  const left = clamp(preferredLeft, margin, viewportWidth - margin - boundedWidth);
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panelHeight;
  const fitsBelow = below + panelHeight <= viewportHeight - margin;
  const placement: GlossaryPanelPlacement =
    !fitsBelow && above >= margin ? "above" : "below";
  const top = clamp(
    placement === "above" ? above : below,
    margin,
    viewportHeight - margin - panelHeight,
  );
  const caretOffset = clamp(
    triggerCenter - left,
    GLOSSARY_CARET_INSET,
    Math.max(GLOSSARY_CARET_INSET, boundedWidth - GLOSSARY_CARET_INSET),
  );

  return Object.freeze({ left, top, placement, caretOffset });
}

function withDerivedOpen(
  state: Omit<GlossaryHintState, "open">,
): GlossaryHintState {
  return Object.freeze({
    ...state,
    open:
      state.pinned ||
      (!state.dismissed && (state.pointerWithin || state.focusWithin)),
  });
}

export function reduceGlossaryHintState(
  state: GlossaryHintState,
  action: GlossaryHintAction,
): GlossaryHintState {
  switch (action.type) {
    case "pointer_enter":
      return withDerivedOpen({
        ...state,
        pointerWithin: true,
        dismissed: false,
      });
    case "pointer_leave":
      return withDerivedOpen({ ...state, pointerWithin: false });
    case "focus_enter":
      return withDerivedOpen({
        ...state,
        focusWithin: true,
        dismissed: false,
      });
    case "focus_leave":
      return withDerivedOpen({
        ...state,
        focusWithin: false,
        dismissed: false,
      });
    case "toggle_pin":
      return state.pinned
        ? withDerivedOpen({ ...state, pinned: false, dismissed: true })
        : withDerivedOpen({ ...state, pinned: true, dismissed: false });
    case "dismiss":
    case "another_hint_opened":
      return withDerivedOpen({ ...state, pinned: false, dismissed: true });
  }
}
