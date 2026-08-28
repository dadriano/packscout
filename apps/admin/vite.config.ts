import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Vercel's native Express adapter only publishes static files from public/.
  // Remove this mode when that hosting adapter is retired; ordinary builds
  // continue to emit dist/ and copy the tracked public/brand assets as before.
  const vercelCdnBuild = mode === "vercel";

  return {
    plugins: [react()],
    publicDir: vercelCdnBuild ? false : "public",
    build: vercelCdnBuild
      ? {
          outDir: "public",
          emptyOutDir: false,
        }
      : undefined,
    server: {
      port: 5173,
    },
  };
});
