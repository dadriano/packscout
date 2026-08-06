import { defineConfig } from "drizzle-kit";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const fromCurrentDirectory = (path: string) => relative(process.cwd(), resolve(packageDirectory, path));

export default defineConfig({
  dialect: "postgresql",
  schema: fromCurrentDirectory("src/schema/index.ts"),
  out: fromCurrentDirectory("drizzle"),
  dbCredentials: {
    url: process.env.PACKSCOUT_DATABASE_URL ?? "postgresql://packscout:packscout@localhost:5432/packscout",
  },
  strict: true,
  verbose: true,
});
