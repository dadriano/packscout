import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AdminDialog } from "../components/AdminDialog";
import { useToast } from "./toast";

export type ConfirmTier = "standard" | "danger" | "danger-typed";

interface BaseConfirmOptions {
  title: string;
  description: ReactNode;
  action: () => Promise<unknown> | unknown;
  confirmLabel?: string;
  cancelLabel?: string;
  successMessage?: string;
}

export type ConfirmOptions =
  | (BaseConfirmOptions & {
      tier?: Exclude<ConfirmTier, "danger-typed">;
      typedAcknowledgment?: never;
    })
  | (BaseConfirmOptions & {
      tier: "danger-typed";
      typedAcknowledgment: string;
    });

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

interface ActiveConfirm {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { showToast } = useToast();
  const [active, setActive] = useState<ActiveConfirm | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [typedValue, setTypedValue] = useState("");
  const typedInputRef = useRef<HTMLInputElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending(false);
        setActionError(null);
        setTypedValue("");
        setActive({ options, resolve });
      }),
    [],
  );

  const cancel = useCallback(() => {
    if (pending) return;
    active?.resolve(false);
    setActive(null);
  }, [active, pending]);

  const runAction = useCallback(async () => {
    if (!active || pending) return;
    setPending(true);
    setActionError(null);
    try {
      await active.options.action();
      if (active.options.successMessage) {
        showToast(active.options.successMessage);
      }
      active.resolve(true);
      setActive(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }, [active, pending, showToast]);

  const value = useMemo(() => ({ confirm }), [confirm]);
  const options = active?.options;
  const tier = options?.tier ?? "standard";
  const requiresTyped = tier === "danger-typed";
  const typedSatisfied =
    !requiresTyped ||
    (Boolean(options?.typedAcknowledgment) &&
      typedValue === options?.typedAcknowledgment);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {options ? (
        <AdminDialog
          open
          size="small"
          title={options.title}
          description={options.description}
          onClose={cancel}
          dismissible={!pending}
          initialFocusRef={
            requiresTyped ? typedInputRef : confirmButtonRef
          }
          footer={
            <>
              <button
                type="button"
                className="admin-button admin-button--secondary"
                onClick={cancel}
                disabled={pending}
              >
                {options.cancelLabel ?? "Cancel"}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={`admin-button admin-button--${tier === "standard" ? "primary" : "danger"}`}
                onClick={() => void runAction()}
                disabled={pending || !typedSatisfied}
              >
                {pending ? "Working…" : (options.confirmLabel ?? "Confirm")}
              </button>
            </>
          }
        >
          {requiresTyped ? (
            <div className="admin-field">
              <label htmlFor="admin-confirm-acknowledgment">
                Type <strong>{options.typedAcknowledgment}</strong> to confirm
              </label>
              <input
                id="admin-confirm-acknowledgment"
                ref={typedInputRef}
                value={typedValue}
                autoComplete="off"
                onChange={(event) => setTypedValue(event.target.value)}
              />
            </div>
          ) : null}
          {actionError ? (
            <p className="admin-inline-error" role="alert">
              The action failed: {actionError}
            </p>
          ) : null}
        </AdminDialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error("useConfirm must be used within ConfirmProvider");
  return context;
}
