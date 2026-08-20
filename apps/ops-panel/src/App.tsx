import { Navigate, Route, Routes } from "react-router-dom";
import { PanelShell } from "./components/PanelShell.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { DatabasePage } from "./pages/DatabasePage.tsx";
import { LogSourcesPage } from "./pages/LogSourcesPage.tsx";
import { LogsPage } from "./pages/LogsPage.tsx";

export function App() {
  return (
    <PanelShell>
      <Routes>
        <Route path="/" element={<Navigate to="/logs" replace />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/logs/sources" element={<LogSourcesPage />} />
        <Route path="/database" element={<DatabasePage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="*" element={<Navigate to="/logs" replace />} />
      </Routes>
    </PanelShell>
  );
}
