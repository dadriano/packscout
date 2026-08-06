import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { createAdminApp } from "./app.ts";
import { readPort } from "./runtime-config.ts";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const adminRoot = path.resolve(serverDirectory, "..");
const workspaceRoot = path.resolve(adminRoot, "..", "..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });

const app = createAdminApp();
const port = readPort(
  process.env.PACKSCOUT_ADMIN_PORT,
  5101,
  "PACKSCOUT_ADMIN_PORT",
);
const isDevelopment = process.env.NODE_ENV !== "production";

if (isDevelopment) {
  const { createServer: createViteServer } = await import("vite");
  const hmrPort = readPort(
    process.env.PACKSCOUT_ADMIN_HMR_PORT,
    port + 1,
    "PACKSCOUT_ADMIN_HMR_PORT",
  );
  const vite = await createViteServer({
    root: adminRoot,
    server: {
      middlewareMode: true,
      hmr: { port: hmrPort },
    },
    appType: "spa",
  });

  app.use(vite.middlewares);
} else {
  const outputDirectory = path.join(adminRoot, "dist");
  app.use(express.static(outputDirectory));
  app.get("*", (_request, response) => {
    response.sendFile(path.join(outputDirectory, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Packscout Admin is available at http://localhost:${port}`);
});
