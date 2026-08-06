import { Route } from "react-router-dom";
import { AdminLayout } from "./layouts/AdminLayout";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";

export const appRoutes = (
  <Route path="/" element={<AdminLayout />}>
    <Route index element={<OverviewPage />} />
    <Route path="*" element={<NotFoundPage />} />
  </Route>
);
