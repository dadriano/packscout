import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const adminRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = path.resolve(adminRoot, "..", "..");
const generatedRoot = path.join(
  repositoryRoot,
  "packages/database/prisma/generated",
);
const clientNames = ["central", "provider"] as const;

/** Keep generated CommonJS clients beside their runtime and native engine. */
export async function buildVercelAdminServer(
  outputDirectory = path.join(adminRoot, "dist"),
): Promise<string> {
  const clientDirectory = path.join(outputDirectory, "prisma");
  await mkdir(outputDirectory, { recursive: true });
  await rm(clientDirectory, { recursive: true, force: true });
  await Promise.all(clientNames.map((name) => cp(
    path.join(generatedRoot, name),
    path.join(clientDirectory, name),
    { recursive: true },
  )));
  const generatedClientImports = new Map(clientNames.map((name) => [
    path.join(generatedRoot, name, "index.js"),
    `./prisma/${name}/index.js`,
  ]));
  const outfile = path.join(outputDirectory, "server.bundle.mjs");

  await build({
    absWorkingDir: adminRoot,
    entryPoints: ["server/vercel-entry.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@prisma/client", "argon2", "express", "pg"],
    // Resolve workspace roots and public subpaths through their package exports.
    // A root-to-file alias also rewrites subpaths into invalid index.ts/<subpath> paths.
    plugins: [{
      name: "generated-prisma-clients",
      setup(builder) {
        builder.onResolve({ filter: /\/prisma\/generated\/.*\/index\.js$/ },
          (input) => {
            const externalPath = generatedClientImports.get(
              path.resolve(input.resolveDir, input.path),
            );
            return externalPath
              ? { path: externalPath, external: true }
              : undefined;
          },
        );
      },
    }],
    outfile,
  });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildVercelAdminServer();
}
