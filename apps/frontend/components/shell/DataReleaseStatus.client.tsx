"use client";

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  presentDataReleaseStatus,
  recordUpdateRefreshIntervalMilliseconds,
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
  const evaluatedAt = "evaluatedAt" in status ? status.evaluatedAt : undefined;
  const dataSource = "dataSource" in status ? status.dataSource : undefined;

  useEffect(() => {
    context?.setStatus(status);
  }, [
    context,
    dataSource,
    evaluatedAt,
    state,
    status,
    updatedAt,
  ]);

  return null;
}

export function DataReleaseStatus() {
  const context = useContext(DataReleaseStatusContext);
  const status = context?.status ?? { state: "loading" };
  const router = useRouter();
  const [clock, setClock] = useState<Readonly<{
    evaluatedAt: string | null;
    elapsedMilliseconds: number;
  }>>({ evaluatedAt: null, elapsedMilliseconds: 0 });
  const refreshInterval = recordUpdateRefreshIntervalMilliseconds(status);
  const evaluatedAt = "evaluatedAt" in status ? status.evaluatedAt : null;
  const updatedAt = "updatedAt" in status ? status.updatedAt : null;

  useEffect(() => {
    if (refreshInterval === null || evaluatedAt === null) return;
    const startedAt = window.performance.now();
    const timer = window.setInterval(() => {
      setClock({
        evaluatedAt,
        elapsedMilliseconds: Math.max(0, window.performance.now() - startedAt),
      });
      router.refresh();
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [evaluatedAt, refreshInterval, router, updatedAt]);

  const trustedPresentationTime =
    evaluatedAt !== null
    ? Date.parse(evaluatedAt) +
      (clock.evaluatedAt === evaluatedAt ? clock.elapsedMilliseconds : 0)
    : Number.NaN;
  const presentation = presentDataReleaseStatus(
    status,
    Number.isFinite(trustedPresentationTime)
      ? trustedPresentationTime
      : 0,
  );

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
