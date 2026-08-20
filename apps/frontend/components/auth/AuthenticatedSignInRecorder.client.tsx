"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { usePackScoutAuth } from "./AuthContext.client";
import {
  decideSignInRecording,
  initialSignInRecordingState,
  recordSignInBestEffort,
} from "./sign-in-recording";

/**
 * Establishes the signed-in visitor's product-user directory record.
 *
 * Product sign-in has no registration step, so the directory learns about a
 * user the first time an authenticated session reaches the backend. The
 * mutation derives everything it stores from the verified identity and is
 * idempotent, so this sends it once per established session and swallows
 * failures: recording is invisible, and nothing here can block sign-in or
 * disturb saved items.
 */
export function AuthenticatedSignInRecorder({
  children,
  sessionKey,
}: Readonly<{ children: ReactNode; sessionKey: string }>) {
  const auth = usePackScoutAuth();
  const signedIn = auth.status === "signed_in";
  const recordSignIn = useMutation(api.productUsers.recordSignIn);
  const recording = useRef(initialSignInRecordingState);

  useEffect(() => {
    const decision = decideSignInRecording(recording.current, {
      signedIn,
      sessionKey,
    });
    recording.current = decision.state;
    if (!decision.record) return;
    void recordSignInBestEffort(() => recordSignIn({}));
  }, [recordSignIn, sessionKey, signedIn]);

  return <>{children}</>;
}
