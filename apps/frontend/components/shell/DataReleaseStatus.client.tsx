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
  presentDataReleaseStatus,
  DataReleaseStatusValue,
} from "@/lib/data-release-status.client";

type DataReleaseStatusContextValue = Readonly<{
  setStatus: (status: DataReleaseStatusValue) => void;
  status: DataReleaseStatusValue;
}>;

const DataReleaseStatusContext = createContext<DataReleaseStatusContextValue | null>(null);

export function DataReleaseStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DataReleaseStatusValue>({ state: "loading" });
  const value = useMemo(() => ({ setStatus, status }), [status]);

  return (
    <DataReleaseStatusContext.Provider value={value}>
      {children}
    </DataReleaseStatusContext.Provider>
  );
}

export function DataReleaseStatusReporter({ status }: { status: DataReleaseStatusValue }) {
  const context = useContext(DataReleaseStatusContext);
  const state = status.state;
  const updatedAt = "updatedAt" in status ? status.updatedAt : undefined;
  const staleAt = "staleAt" in status ? status.staleAt : undefined;
  const dataSource = "dataSource" in status ? status.dataSource : undefined;

  useEffect(() => {
    context?.setStatus(status);
  }, [context, dataSource, staleAt, state, status, updatedAt]);

  return null;
}

export function DataReleaseStatus() {
  const context = useContext(DataReleaseStatusContext);
  const status = context?.status ?? { state: "loading" };
  const [clockRevision, setClockRevision] = useState(0);
  const staleAt = "staleAt" in status ? Date.parse(status.staleAt) : Number.NaN;

  useEffect(() => {
    if (
      status.state !== "fresh" ||
      !Number.isFinite(staleAt) ||
      Date.now() >= staleAt
    ) return;
    const maximumDelay = 2_147_483_647;
    const delay = Math.min(
      maximumDelay,
      Math.max(0, staleAt - Date.now() + 25),
    );
    const timer = window.setTimeout(
      () => setClockRevision((revision) => revision + 1),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [clockRevision, staleAt, status.state]);

  const presentation = presentDataReleaseStatus(status);

  return (
    <div
      aria-label={presentation.exactLabel}
      aria-live="polite"
      aria-atomic="true"
      className="data-release-status"
      data-source={"dataSource" in status ? status.dataSource : undefined}
      data-state={presentation.state}
      role="status"
    >
      <span aria-hidden="true" className="data-release-status__dot" />
      <span>{presentation.visibleLabel}</span>
    </div>
  );
}
