import { useEffect, useRef } from "react";
import {
  groupShortcuts,
  shortcutKeyLabel,
  type ShortcutBinding,
} from "../../logs/shortcuts.ts";

/**
 * The shortcuts, listed from the registry rather than from a hand-kept table.
 *
 * A shortcut nobody can discover is a shortcut nobody uses, and a help page
 * maintained separately from the bindings is a help page that goes out of date
 * on the first change. Generating it from the registry means a binding added
 * later — admin-tools/012's jump-to-start, for one — documents itself.
 */

export interface ShortcutHelpDialogProps {
  open: boolean;
  bindings: readonly ShortcutBinding[];
  onClose: () => void;
}

export function ShortcutHelpDialog({ open, bindings, onClose }: ShortcutHelpDialogProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="panel-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="panel-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="panel-shortcuts-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-modal-head">
          <h2 id="panel-shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" className="panel-button" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
        <p className="panel-log-count">
          Shortcuts stay out of text fields: while you are typing, only Escape acts.
        </p>
        {groupShortcuts(bindings).map((section) => (
          <section key={section.group} className="panel-modal-section">
            <h3>{section.group}</h3>
            <dl className="panel-shortcut-list">
              {section.bindings.map((binding) => (
                <div key={binding.id}>
                  <dt>
                    <kbd>{shortcutKeyLabel(binding)}</kbd>
                  </dt>
                  <dd>{binding.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
