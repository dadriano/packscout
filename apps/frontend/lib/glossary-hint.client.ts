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

export type GlossaryPanelPosition = Readonly<{
  left: number;
  top: number;
}>;

export type GlossaryPanelPositionInput = Readonly<{
  align: "start" | "end";
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

export function positionGlossaryPanel({
  align,
  viewportWidth,
  viewportHeight,
  trigger,
  panelWidth,
  panelHeight,
  margin = 16,
  gap = 8,
}: GlossaryPanelPositionInput): GlossaryPanelPosition {
  const boundedWidth = Math.min(panelWidth, Math.max(0, viewportWidth - margin * 2));
  const preferredLeft =
    align === "end" ? trigger.right - boundedWidth : trigger.left;
  const left = Math.max(
    margin,
    Math.min(preferredLeft, viewportWidth - margin - boundedWidth),
  );
  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panelHeight;
  const preferredTop =
    below + panelHeight > viewportHeight - margin && above >= margin
      ? above
      : below;
  const top = Math.max(
    margin,
    Math.min(preferredTop, viewportHeight - margin - panelHeight),
  );

  return Object.freeze({ left, top });
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
