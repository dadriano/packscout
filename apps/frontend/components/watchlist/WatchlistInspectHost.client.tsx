"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  ChaseInspectProvider,
  useOptionalChaseInspect,
} from "@/components/catalog/ChaseCollectibleInspector.client";
import { RepackInspector } from "@/components/catalog/PackInspector.client";
import type { CollectibleIdentityInput } from "@/lib/collectible-identity";
import {
  parsePublicRepackDetailResponse,
  type PublicRepackDetailPage,
} from "@/lib/public-repack-detail";
import {
  WATCHLIST_PACK_INSPECT_FAILED_COPY,
  WATCHLIST_PACK_INSPECT_LOADING_COPY,
  WATCHLIST_PACK_INSPECT_MISSING_COPY,
} from "@/lib/watchlist";
import styles from "./Watchlist.module.css";

type PackInspectRequest = Readonly<{
  publicRepackId: string;
  trigger: HTMLElement | null;
}>;

type PackLoad =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ready"; page: PublicRepackDetailPage }>;

export type WatchlistInspectApi = Readonly<{
  openPack: (publicRepackId: string, trigger: HTMLElement | null) => void;
  openChase: (
    publicCollectibleId: string,
    identity: CollectibleIdentityInput | undefined,
    trigger: HTMLElement | null,
  ) => void;
}>;

const WatchlistInspectContext = createContext<WatchlistInspectApi | null>(null);

export function useWatchlistInspect(): WatchlistInspectApi {
  const value = useContext(WatchlistInspectContext);
  if (value === null) {
    throw new Error("Watchlist inspect controls require WatchlistInspectHost");
  }
  return value;
}

export function WatchlistInspectHost({
  children,
  onInspectClosed,
}: Readonly<{
  children: ReactNode;
  onInspectClosed?: () => void;
}>) {
  return (
    <ChaseInspectProvider onClosed={onInspectClosed}>
      <WatchlistPackInspectHost onInspectClosed={onInspectClosed}>
        {children}
      </WatchlistPackInspectHost>
    </ChaseInspectProvider>
  );
}

function WatchlistPackInspectHost({
  children,
  onInspectClosed,
}: Readonly<{
  children: ReactNode;
  onInspectClosed?: () => void;
}>) {
  const chaseInspect = useOptionalChaseInspect();
  const [request, setRequest] = useState<PackInspectRequest | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openPack = useCallback(
    (publicRepackId: string, trigger: HTMLElement | null) => {
      returnFocusRef.current = trigger;
      setRetryKey(0);
      setRequest({ publicRepackId, trigger });
    },
    [],
  );

  const openChase = useCallback(
    (
      publicCollectibleId: string,
      identity: CollectibleIdentityInput | undefined,
      trigger: HTMLElement | null,
    ) => {
      chaseInspect?.open({ publicCollectibleId, identity, trigger });
    },
    [chaseInspect],
  );

  useEffect(() => {
    return chaseInspect?.registerPackOpener(openPack);
  }, [chaseInspect, openPack]);

  const closePack = useCallback(
    (restoreFocus = true) => {
      setRequest(null);
      onInspectClosed?.();
      if (restoreFocus) {
        requestAnimationFrame(() => returnFocusRef.current?.focus());
      }
    },
    [onInspectClosed],
  );

  const value = useMemo(
    () => ({ openPack, openChase }),
    [openChase, openPack],
  );

  return (
    <WatchlistInspectContext.Provider value={value}>
      {children}
      {request ? (
        <WatchlistPackInspector
          key={`${request.publicRepackId}:${retryKey}`}
          onClose={closePack}
          onRetry={() => setRetryKey((current) => current + 1)}
          request={request}
          returnFocusRef={returnFocusRef}
        />
      ) : null}
    </WatchlistInspectContext.Provider>
  );
}

function WatchlistPackInspector({
  request,
  onClose,
  onRetry,
  returnFocusRef,
}: Readonly<{
  request: PackInspectRequest;
  onClose: (restoreFocus?: boolean) => void;
  onRetry: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<PackLoad>({ status: "loading" });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (load.status === "ready") return;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [load.status]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/repacks/${encodeURIComponent(request.publicRepackId)}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
      .then(async (response) => parsePublicRepackDetailResponse(await response.json()))
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setLoad({
            status: result.code === "REPACK_NOT_FOUND" ? "missing" : "failed",
          });
          return;
        }
        setLoad({ status: "ready", page: result.data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ status: "failed" });
      });
    return () => controller.abort();
  }, [request.publicRepackId]);

  if (load.status === "ready") {
    return (
      <RepackInspector
        onClose={() => onClose(true)}
        placement="sheet"
        release={load.page.release}
        repack={load.page.repack}
        returnFocusRef={returnFocusRef}
      />
    );
  }

  const headingId = `watchlist-pack-inspect-${request.publicRepackId}`;
  const statusCopy =
    load.status === "loading"
      ? WATCHLIST_PACK_INSPECT_LOADING_COPY
      : load.status === "missing"
        ? WATCHLIST_PACK_INSPECT_MISSING_COPY
        : WATCHLIST_PACK_INSPECT_FAILED_COPY;

  function closeInspector() {
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose(true);
  }

  function handleSheetCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    closeInspector();
  }

  function handleSheetKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeInspector();
    }
  }

  return (
    <dialog
      aria-labelledby={headingId}
      className={styles.inspectDialog}
      onCancel={handleSheetCancel}
      onKeyDown={handleSheetKeys}
      ref={dialogRef}
    >
      <button
        aria-label="Close pack details"
        autoFocus
        className={styles.inspectClose}
        onClick={closeInspector}
        type="button"
      >
        <span aria-hidden="true">×</span>
      </button>
      <h2 className={styles.inspectTitle} id={headingId}>
        Pack details
      </h2>
      <p aria-live="polite" className={styles.copy} role="status">
        {statusCopy}
      </p>
      {load.status === "failed" ? (
        <button
          className="route-action"
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
      ) : null}
    </dialog>
  );
}
