import eslint from "@eslint/js";
import typescriptEslint from "typescript-eslint";

export default typescriptEslint.config(
  { ignores: ["dist/**"] },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
);
