import { useCallback, useEffect, useState } from "react";
import { panelFetch } from "../api/panel-client.ts";
import { ACTIVITY_PATH, type ActivityPayload } from "../api/panel-types.ts";

export interface ActivityState {
  status: "loading" | "ready" | "error";
  payload: ActivityPayload | null;
  error: string | null;
  reload: () => void;
}

/** Recent privileged activity: succeeded, failed, and rejected attempts. */
export function useActivity(): ActivityState {
  const [payload, setPayload] = useState<ActivityPayload | null>(null);
  const [status, setStatus] = useState<ActivityState["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    panelFetch<ActivityPayload>(ACTIVITY_PATH)
      .then((next) => {
        if (cancelled) return;
        setPayload(next);
        setStatus("ready");
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(
          cause instanceof Error
            ? cause.message
            : "The panel could not read its activity trail.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return { status, payload, error, reload };
}
