"use client";

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  presentDataReleaseStatus,
  providerHealthRefreshDelayMilliseconds,
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
  const freshThrough = "freshThrough" in status ? status.freshThrough : undefined;
  const evaluatedAt = "evaluatedAt" in status ? status.evaluatedAt : undefined;
  const nextHealthEvaluationAt = "nextHealthEvaluationAt" in status
    ? status.nextHealthEvaluationAt
    : undefined;
  const dataSource = "dataSource" in status ? status.dataSource : undefined;

  useEffect(() => {
    context?.setStatus(status);
  }, [
    context,
    dataSource,
    evaluatedAt,
    freshThrough,
    nextHealthEvaluationAt,
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
  const refreshedBoundary = useRef<string | null>(null);
  const [clockRevision, setClockRevision] = useState(0);
  const refreshDelay = providerHealthRefreshDelayMilliseconds(status);
  const refreshBoundary =
    "evaluatedAt" in status &&
      "nextHealthEvaluationAt" in status &&
      status.evaluatedAt !== undefined &&
      status.nextHealthEvaluationAt !== undefined &&
      status.nextHealthEvaluationAt !== null
      ? `${status.evaluatedAt}:${status.nextHealthEvaluationAt}`
      : null;

  useEffect(() => {
    if (
      refreshDelay === null ||
      refreshBoundary === null ||
      refreshedBoundary.current === refreshBoundary
    ) return;
    const maximumDelay = 2_147_483_647;
    const delay = Math.min(
      maximumDelay,
      refreshDelay + 25,
    );
    const timer = window.setTimeout(() => {
      refreshedBoundary.current = refreshBoundary;
      setClockRevision((revision) => revision + 1);
      router.refresh();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [clockRevision, refreshBoundary, refreshDelay, router]);

  const trustedPresentationTime =
    "evaluatedAt" in status && status.evaluatedAt !== undefined
    ? Date.parse(status.evaluatedAt)
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
