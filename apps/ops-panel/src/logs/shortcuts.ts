/**
 * The keyboard, as a registry rather than a switch statement.
 *
 * An operations panel is used with both hands on the keyboard during exactly the
 * moments when reaching for a mouse is most annoying, so the core loop — find,
 * pause, jump back to live, move between services — has to be typeable.
 *
 * Two properties make that safe rather than infuriating:
 *
 *  - *nothing fires while typing*. A single-letter shortcut that steals the "p"
 *    out of a search term is worse than having no shortcuts, so bindings are
 *    suppressed inside text inputs unless they explicitly opt in (Escape does,
 *    because leaving a field is the one thing a field must always allow).
 *  - *nothing is hidden*. Every binding carries its own description, and the
 *    help dialog is generated from the registry, so a binding that exists is a
 *    binding that is documented. admin-tools/012 registers jump-to-start into
 *    this same registry and appears in help without touching the dialog.
 *
 * Modified keystrokes are left alone entirely: those belong to the browser and
 * the operating system, and a log viewer has no business competing for them.
 */

export interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** The parts of an event target that decide whether someone is typing. */
export interface TypingTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

export interface ShortcutBinding {
  id: string;
  /** The key as reported by the event, matched case-insensitively. */
  key: string;
  /** How the key is written in help; defaults to `key`. */
  keyLabel?: string;
  description: string;
  /** Help dialog section; sections appear in first-registered order. */
  group: string;
  allowWhileTyping?: boolean;
  run: () => void;
}

/** Inputs that produce text. A checkbox is not one of them. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isTypingTarget(target: TypingTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NON_TEXT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
}

export interface ShortcutRegistry {
  /** Returns the function that removes the binding again. */
  register(binding: ShortcutBinding): () => void;
  bindings(): readonly ShortcutBinding[];
  /** True when a binding ran and the keystroke should be consumed. */
  handle(event: ShortcutEventLike, target?: TypingTargetLike | null): boolean;
}

export function createShortcutRegistry(
  initial: readonly ShortcutBinding[] = [],
): ShortcutRegistry {
  const registered = new Map<string, ShortcutBinding>();
  for (const binding of initial) registered.set(binding.id, binding);

  return {
    register(binding) {
      registered.set(binding.id, binding);
      return () => {
        // Only retract the binding still owned by this registration; a later
        // one under the same id has replaced it and is not ours to remove.
        if (registered.get(binding.id) === binding) registered.delete(binding.id);
      };
    },

    bindings: () => [...registered.values()],

    handle(event, target) {
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      const typing = isTypingTarget(target);
      const key = event.key.toLowerCase();
      for (const binding of registered.values()) {
        if (binding.key.toLowerCase() !== key) continue;
        if (typing && !binding.allowWhileTyping) continue;
        binding.run();
        return true;
      }
      return false;
    },
  };
}

export interface ShortcutGroup {
  group: string;
  bindings: readonly ShortcutBinding[];
}

/** Bindings arranged for the help dialog, in first-registered group order. */
export function groupShortcuts(
  bindings: readonly ShortcutBinding[],
): ShortcutGroup[] {
  const groups: ShortcutGroup[] = [];
  const index = new Map<string, ShortcutBinding[]>();
  for (const binding of bindings) {
    const existing = index.get(binding.group);
    if (existing) {
      existing.push(binding);
      continue;
    }
    const created = [binding];
    index.set(binding.group, created);
    groups.push({ group: binding.group, bindings: created });
  }
  return groups;
}

export function shortcutKeyLabel(binding: ShortcutBinding): string {
  return binding.keyLabel ?? binding.key;
}
