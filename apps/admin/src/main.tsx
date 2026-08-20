import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Outlet,
  Route,
  RouterProvider,
} from "react-router-dom";
import { appRoutes } from "./App";
import { ThemeProvider } from "./hooks/useTheme";
import { ConfirmProvider } from "./providers/confirm";
import { SessionProvider } from "./providers/session";
import { ToastProvider } from "./providers/toast";
import "./theme.css";
import "./index.css";
import "./data-providers.css";
import "./operations.css";
import "./alerts.css";
import "./product-users.css";

function RootProviders() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
          <SessionProvider>
            <Outlet />
          </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(<Route element={<RootProviders />}>{appRoutes}</Route>),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
