import type { ShortcutBinding } from "./shortcuts.ts";

/**
 * The log surface's own bindings, declared as data.
 *
 * Keeping them out of the page means the set can be read, tested, and extended
 * without a browser — and it makes the keys visible in one place, which is the
 * only way to notice that two of them collide.
 *
 * The choices are the ones muscle memory already knows: `/` opens search, as it
 * does in every pager and every code host; `?` opens help, as it does in every
 * application that has help.
 */

export interface LogShortcutActions {
  /** Rail order, so previous/next matches what is on screen. */
  services: readonly string[];
  focusedService: string | null;
  focusFilter: () => void;
  togglePause: () => void;
  jumpToLive: () => void;
  focusService: (service: string | null) => void;
  toggleWrap: () => void;
  openHelp: () => void;
  dismiss: () => void;
}

/**
 * The service one step away, wrapping around.
 *
 * With nothing focused, stepping forward starts at the first service and
 * stepping back starts at the last, so both directions reach a service on the
 * first press rather than needing one to prime them.
 */
export function neighbourService(
  services: readonly string[],
  current: string | null,
  step: number,
): string | null {
  if (services.length === 0) return null;
  if (current === null) return (step >= 0 ? services[0] : services[services.length - 1]) ?? null;
  const index = services.indexOf(current);
  if (index === -1) return services[0] ?? null;
  const next = (index + step + services.length) % services.length;
  return services[next] ?? null;
}

export function logShortcutBindings(actions: LogShortcutActions): ShortcutBinding[] {
  const step = (direction: number) => () => {
    const next = neighbourService(actions.services, actions.focusedService, direction);
    if (next !== null) actions.focusService(next);
  };

  return [
    {
      id: "focus-filter",
      key: "/",
      description: "Focus the filter box",
      group: "Filtering",
      run: actions.focusFilter,
    },
    {
      id: "toggle-pause",
      key: "p",
      description: "Pause or resume the stream",
      group: "Stream",
      run: actions.togglePause,
    },
    {
      id: "jump-to-live",
      key: "l",
      description: "Jump back to the newest output",
      group: "Stream",
      run: actions.jumpToLive,
    },
    {
      id: "previous-service",
      key: "[",
      description: "Focus the previous service",
      group: "Services",
      run: step(-1),
    },
    {
      id: "next-service",
      key: "]",
      description: "Focus the next service",
      group: "Services",
      run: step(1),
    },
    {
      id: "all-services",
      key: "a",
      description: "Show every service again",
      group: "Services",
      run: () => actions.focusService(null),
    },
    {
      id: "toggle-wrap",
      key: "w",
      description: "Wrap or unwrap long lines",
      group: "View",
      run: actions.toggleWrap,
    },
    {
      id: "shortcut-help",
      key: "?",
      keyLabel: "?",
      description: "Show this list",
      group: "View",
      run: actions.openHelp,
    },
    {
      id: "dismiss",
      key: "Escape",
      keyLabel: "Esc",
      description: "Close this dialog, or leave the filter box",
      group: "View",
      allowWhileTyping: true,
      run: actions.dismiss,
    },
  ];
}
