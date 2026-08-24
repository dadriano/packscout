"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { usePackScoutAuth } from "./AuthContext.client";
import {
  decideSignInRecording,
  initialSignInRecordingState,
  recordSignInBestEffort,
  settleSignInRecording,
} from "./sign-in-recording";

/**
 * Establishes the signed-in visitor's product-user directory record and,
 * with it, their closed-beta admission decision.
 *
 * Product sign-in has no registration step, so the directory learns about a
 * user the first time an authenticated session reaches the backend. The
 * establishment mutation (closed-beta-access/001) funnels through the same
 * directory write path sign-in recording always used, stamps the
 * awaiting-review default on first contact, and refreshes identity
 * attributes on later ones — which keeps the record the server-side gate
 * routes on fresh. It derives everything it stores from the verified
 * identity and is idempotent, so this sends it once per established session
 * and absorbs failures: recording is invisible, and nothing here can block
 * sign-in or disturb saved items. The gate never depends on this write
 * landing — it re-reads effective access per request, and a missing record
 * simply reads as awaiting review.
 *
 * "Once" counts writes that completed, not writes that were sent. A write that
 * fails gets a few further attempts within the session, each on a timer the
 * effect owns and cancels, so a backend that is down is asked again rather
 * than spun against; a write that succeeded is never repeated, so re-renders
 * and Convex reconnects still cost the directory nothing. All of that
 * bookkeeping lives in a ref, because none of it is rendered and none of it
 * should cost a render.
 */
export function AuthenticatedSignInRecorder({
  children,
  sessionKey,
}: Readonly<{ children: ReactNode; sessionKey: string }>) {
  const auth = usePackScoutAuth();
  const signedIn = auth.status === "signed_in";
  const establishAccess = useMutation(api.productUserAccess.establishAccess);
  const recording = useRef(initialSignInRecordingState);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const attempt = () => {
      const decision = decideSignInRecording(recording.current, {
        signedIn,
        sessionKey,
      });
      recording.current = decision.state;
      if (!decision.record) return;
      // recordSignInBestEffort settles both ways and never rejects, so this
      // chain cannot raise into the provider tree.
      void recordSignInBestEffort(() => establishAccess({})).then((outcome) => {
        const settled = settleSignInRecording(
          recording.current,
          sessionKey,
          outcome,
        );
        recording.current = settled.state;
        if (!active || settled.retryDelayMs === null) return;
        retryTimer = setTimeout(attempt, settled.retryDelayMs);
      });
    };

    attempt();
    // A changed session or an unmount drops the pending retry; the attempt
    // count survives in the ref, so a reconnect resumes rather than restarts.
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [establishAccess, sessionKey, signedIn]);

  return <>{children}</>;
}
