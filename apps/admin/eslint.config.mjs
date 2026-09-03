import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import typescriptEslint from "typescript-eslint";

export default typescriptEslint.config(
  {
    ignores: ["dist/**", "public/assets/**", "server.bundle.mjs"],
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: ["src/**/*.{ts,tsx}"],
  },
  {
    files: ["server/**/*.ts", "vite.config.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
