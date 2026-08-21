import { useEffect, useMemo } from "react";
import {
  createShortcutRegistry,
  type ShortcutBinding,
  type ShortcutRegistry,
  type TypingTargetLike,
} from "../logs/shortcuts.ts";

/**
 * The registry, wired to the document exactly once.
 *
 * One listener rather than one per binding, so precedence is decided by the
 * registry's own rules instead of by DOM ordering, and so a surface that adds a
 * binding later (admin-tools/012) does not also add an event listener.
 */
export function useShortcutRegistry(): ShortcutRegistry {
  const registry = useMemo(() => createShortcutRegistry(), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as (TypingTargetLike & EventTarget) | null;
      if (!registry.handle(event, target)) return;
      // Consumed: stop the browser from also acting on it — "/" opens quick-find
      // in some browsers, and "?" would type into whatever has focus.
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [registry]);

  return registry;
}

/**
 * Register a set of bindings for as long as the caller is mounted.
 *
 * `bindings` must be memoised by the caller: it is the effect's dependency, so
 * an unstable array would unregister and re-register on every render and, with
 * it, reorder the help dialog.
 */
export function useShortcuts(
  registry: ShortcutRegistry,
  bindings: readonly ShortcutBinding[],
): void {
  useEffect(() => {
    const removals = bindings.map((binding) => registry.register(binding));
    return () => {
      for (const remove of removals) remove();
    };
  }, [bindings, registry]);
}
