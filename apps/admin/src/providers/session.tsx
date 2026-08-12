import type { AuthSessionResponse } from "@packscout/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  forgetAuthSession,
  getSession,
  logout,
  subscribeToAuthSession,
} from "../api/auth";
import {
  AdminApiError,
  subscribeToAuthRequired,
} from "../api/client";

type SessionStatus =
  | { phase: "loading" }
  | { phase: "authenticated"; session: AuthSessionResponse }
  | { phase: "unauthenticated"; reason: "required" | "expired" }
  | { phase: "unavailable" };

interface SessionContextValue {
  status: SessionStatus;
  retry: () => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: ReactNode;
  initialSession?: AuthSessionResponse;
}

export function SessionProvider({
  children,
  initialSession,
}: SessionProviderProps) {
  const [status, setStatus] = useState<SessionStatus>(
    initialSession
      ? { phase: "authenticated", session: initialSession }
      : { phase: "loading" },
  );
  const [retryIndex, setRetryIndex] = useState(0);

  useEffect(() => {
    const unsubscribeSession = subscribeToAuthSession((session) => {
      setStatus(
        session
          ? { phase: "authenticated", session }
          : { phase: "unauthenticated", reason: "required" },
      );
    });
    const unsubscribeRequired = subscribeToAuthRequired(() => {
      forgetAuthSession();
      setStatus({ phase: "unauthenticated", reason: "expired" });
    });

    if (!initialSession) {
      let active = true;
      void getSession().catch((error: unknown) => {
        if (!active) return;
        if (error instanceof AdminApiError && error.status === 401) {
          setStatus({ phase: "unauthenticated", reason: "required" });
          return;
        }
        setStatus({ phase: "unavailable" });
      });
      return () => {
        active = false;
        unsubscribeSession();
        unsubscribeRequired();
      };
    }

    return () => {
      unsubscribeSession();
      unsubscribeRequired();
    };
  }, [initialSession, retryIndex]);

  const retry = useCallback(() => {
    setStatus({ phase: "loading" });
    setRetryIndex((current) => current + 1);
  }, []);

  const signOut = useCallback(async () => {
    await logout();
  }, []);

  const value = useMemo(
    () => ({ status, retry, signOut }),
    [retry, signOut, status],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used within SessionProvider");
  return context;
}
