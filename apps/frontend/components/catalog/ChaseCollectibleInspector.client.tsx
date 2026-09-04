"use client";

import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesiredCollectibleRepackResultsV3 } from "@packscout/contracts";
import { SavedCollectibleButton } from "@/components/auth/SavedItemButton.client";
import { CatalogImage } from "@/components/catalog/CatalogImage.client";
import type { CollectibleIdentityInput } from "@/lib/collectible-identity";
import { parseFindRepacksByDesiredCollectibleV3Result } from "@/lib/public-repacks-v3";
import {
  presentChaseCollectible,
  presentChaseInspectStatus,
  presentChasePackListSummary,
  presentChasePackMatch,
} from "./chase-collectible-presentation";
import styles from "./ChaseCollectibleInspector.module.css";

export type ChaseInspectRequest = Readonly<{
  publicCollectibleId: string;
  identity?: CollectibleIdentityInput;
  trigger: HTMLElement | null;
}>;

type PackOpener = (publicRepackId: string, trigger: HTMLElement | null) => void;

type ChaseInspectContextValue = Readonly<{
  open: (request: ChaseInspectRequest) => void;
  close: (restoreFocus?: boolean) => void;
  registerPackOpener: (opener: PackOpener | null) => () => void;
}>;

const ChaseInspectContext = createContext<ChaseInspectContextValue | null>(null);

export function useOptionalChaseInspect(): ChaseInspectContextValue | null {
  return useContext(ChaseInspectContext);
}

export function ChaseInspectProvider({
  children,
  onClosed,
}: {
  readonly children: ReactNode;
  readonly onClosed?: () => void;
}) {
  const [request, setRequest] = useState<ChaseInspectRequest | null>(null);
  const packOpenerRef = useRef<PackOpener | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const open = useCallback((next: ChaseInspectRequest) => {
    returnFocusRef.current = next.trigger;
    setRequest(next);
  }, []);

  const close = useCallback((restoreFocus = true) => {
    setRequest(null);
    onClosed?.();
    if (restoreFocus) {
      requestAnimationFrame(() => returnFocusRef.current?.focus());
    }
  }, [onClosed]);

  const registerPackOpener = useCallback((opener: PackOpener | null) => {
    packOpenerRef.current = opener;
    return () => {
      if (packOpenerRef.current === opener) packOpenerRef.current = null;
    };
  }, []);

  const value = useMemo(
    () => ({ open, close, registerPackOpener }),
    [close, open, registerPackOpener],
  );

  return (
    <ChaseInspectContext.Provider value={value}>
      {children}
      {request ? (
        <ChaseCollectibleInspector
          key={request.publicCollectibleId}
          onClose={close}
          onSelectPack={(publicRepackId, trigger) => {
            const opener = packOpenerRef.current;
            close(false);
            opener?.(publicRepackId, trigger);
          }}
          request={request}
        />
      ) : null}
    </ChaseInspectContext.Provider>
  );
}

type InspectorLoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ready"; data: DesiredCollectibleRepackResultsV3 }>;

function ChaseCollectibleInspector({
  request,
  onClose,
  onSelectPack,
}: Readonly<{
  request: ChaseInspectRequest;
  onClose: () => void;
  onSelectPack: (publicRepackId: string, trigger: HTMLElement | null) => void;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<InspectorLoadState>({ status: "loading" });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      `/api/collectibles/${encodeURIComponent(request.publicCollectibleId)}/repacks`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      },
    )
      .then(async (response) => parseFindRepacksByDesiredCollectibleV3Result(
        await response.json(),
      ))
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setLoad({
            status: result.code === "COLLECTIBLE_NOT_FOUND" ? "missing" : "failed",
          });
          return;
        }
        setLoad({ status: "ready", data: result.data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ status: "failed" });
      });
    return () => controller.abort();
  }, [request.publicCollectibleId]);

  function closeInspector() {
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose();
  }

  function handleSheetCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    closeInspector();
  }

  function handleSheetKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeInspector();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const collectible = load.status === "ready" ? load.data.desiredCollectible : null;
  const presentation = presentChaseCollectible({
    collectible,
    identity: request.identity,
  });
  const matches = load.status === "ready" ? load.data.matches : [];
  const total = load.status === "ready" ? load.data.total : 0;
  const headingId = `chase-inspector-${request.publicCollectibleId}`;
  const statusCopy = load.status === "ready"
    ? presentChasePackListSummary(matches.length, total)
    : presentChaseInspectStatus(load.status);

  return (
    <dialog
      aria-labelledby={headingId}
      className={styles.inspector}
      onCancel={handleSheetCancel}
      onKeyDown={handleSheetKeys}
      ref={dialogRef}
    >
      <button
        aria-label="Close chase details"
        autoFocus
        className={styles.closeButton}
        onClick={closeInspector}
        type="button"
      >
        <span aria-hidden="true">×</span>
      </button>

      <header className={styles.hero}>
        <CatalogImage
          fallback="none"
          fallbackAlt={presentation.name}
          image={presentation.image}
          variant="chase"
        />
        <div className={styles.identity}>
          <p className={styles.eyebrow}>Desired chase</p>
          <h2 className={styles.name} id={headingId}>
            {presentation.name}
          </h2>
          {presentation.descriptor ? (
            <p className={styles.descriptor}>{presentation.descriptor}</p>
          ) : null}
          {load.status === "ready" ? (
            <p className={styles.value}>
              <span className={styles.valueLabel}>Market value</span>
              <span>{presentation.valuationLabel}</span>
              {presentation.valuationTypeLabel ? (
                <small>{presentation.valuationTypeLabel}</small>
              ) : null}
            </p>
          ) : null}
          <div className={styles.saveAction}>
            <SavedCollectibleButton
              publicCollectibleId={request.publicCollectibleId}
            />
          </div>
        </div>
      </header>

      <section aria-labelledby={`${headingId}-packs`} className={styles.packs}>
        <h3 id={`${headingId}-packs`}>Packs that include this chase</h3>
        <p aria-live="polite" className={styles.status} role="status">
          {statusCopy}
        </p>
        {load.status === "ready" && matches.length > 0 ? (
          <ul className={styles.packList}>
            {matches.map((match) => {
              const pack = presentChasePackMatch(match);
              return (
                <li key={pack.publicRepackId}>
                  <button
                    className={styles.packButton}
                    onClick={(event) =>
                      onSelectPack(pack.publicRepackId, event.currentTarget)
                    }
                    type="button"
                  >
                    <span className={styles.packName}>{pack.name}</span>
                    <span className={styles.packMeta}>
                      {pack.vendorDisplayName} · {pack.priceLabel}
                    </span>
                    <small>
                      {pack.evidenceLabel} · {pack.matchConfidenceLabel}
                    </small>
                    <span className="sr-only">{pack.accessibleLabel}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </dialog>
  );
}
