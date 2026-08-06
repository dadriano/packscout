import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

export type AdminDialogSize = "small" | "medium" | "large";

interface AdminDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: AdminDialogSize;
  dismissible?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const openDialogs: string[] = [];
let bodyLockDepth = 0;
let bodyOverflowBeforeLock = "";

export function AdminDialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = "medium",
  dismissible = true,
  initialFocusRef,
}: AdminDialogProps) {
  const dialogId = useId();
  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openDialogs.push(dialogId);
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      (initialFocusRef?.current ?? panelRef.current)?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      const index = openDialogs.lastIndexOf(dialogId);
      if (index >= 0) openDialogs.splice(index, 1);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [dialogId, initialFocusRef, open]);

  useEffect(() => {
    if (!open) return;
    if (bodyLockDepth === 0) {
      bodyOverflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    bodyLockDepth += 1;

    return () => {
      bodyLockDepth = Math.max(0, bodyLockDepth - 1);
      if (bodyLockDepth === 0) {
        document.body.style.overflow = bodyOverflowBeforeLock;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || !dismissible) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        openDialogs[openDialogs.length - 1] === dialogId
      ) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [dialogId, dismissible, onClose, open]);

  const trapFocus = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      FOCUSABLE_SELECTOR,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) return null;

  return (
    <div className="admin-dialog-shell" role="presentation">
      <button
        type="button"
        className="admin-dialog-backdrop"
        aria-label="Close dialog"
        tabIndex={dismissible ? 0 : -1}
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={panelRef}
        className={`admin-dialog admin-dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <header className="admin-dialog__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          {dismissible ? (
            <button
              type="button"
              className="admin-icon-button"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </header>
        <div className="admin-dialog__body">{children}</div>
        {footer ? <footer className="admin-dialog__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
