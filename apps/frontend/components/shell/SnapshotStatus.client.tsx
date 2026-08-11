"use client";

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  presentSnapshotStatus,
  SnapshotStatusValue,
} from "@/lib/snapshot-status.client";

type SnapshotStatusContextValue = Readonly<{
  setStatus: (status: SnapshotStatusValue) => void;
  status: SnapshotStatusValue;
}>;

const SnapshotStatusContext = createContext<SnapshotStatusContextValue | null>(null);

export function SnapshotStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SnapshotStatusValue>({ state: "loading" });
  const value = useMemo(() => ({ setStatus, status }), [status]);

  return (
    <SnapshotStatusContext.Provider value={value}>
      {children}
    </SnapshotStatusContext.Provider>
  );
}

export function ShellStatusReporter({ status }: { status: SnapshotStatusValue }) {
  const context = useContext(SnapshotStatusContext);
  const state = status.state;
  const updatedAt = "updatedAt" in status ? status.updatedAt : undefined;

  useEffect(() => {
    context?.setStatus(status);
  }, [context, state, status, updatedAt]);

  return null;
}

export function SnapshotStatus() {
  const context = useContext(SnapshotStatusContext);
  const status = context?.status ?? { state: "loading" };
  const presentation = presentSnapshotStatus(status);

  return (
    <div
      aria-label={presentation.exactLabel}
      aria-live="polite"
      aria-atomic="true"
      className="snapshot-status"
      data-state={presentation.state}
      role="status"
    >
      <span aria-hidden="true" className="snapshot-status__dot" />
      <span>{presentation.visibleLabel}</span>
    </div>
  );
}
