import eslint from "@eslint/js";
import globals from "globals";
import typescriptEslint from "typescript-eslint";

export default typescriptEslint.config(
  { ignores: ["dist/**", "drizzle/**"] },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ["src/**/*.ts", "prisma/**/*.ts", "drizzle.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
