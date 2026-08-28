import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The generated Vercel server bundle lives in dist/, one level below the app
 * root that owns public/. Keep this calculation explicit so moving the bundle
 * cannot silently leave the SPA fallback pointing at a nonexistent directory.
 */
export function resolveVercelAdminRoot(bundleModuleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(bundleModuleUrl)), "..");
}
