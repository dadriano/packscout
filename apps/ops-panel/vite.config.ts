import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The panel is served by its own Express process through Vite middleware mode.
// There is no production build target: the panel is a local developer tool.
export default defineConfig({
  plugins: [react()],
  appType: "spa",
});
