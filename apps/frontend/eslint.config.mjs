import nextConfig from "eslint-config-next";
import { IGNORED_GLOBS } from "../../scripts/ignored-directories.mjs";

const eslintConfig = [
  ...nextConfig,
  {
    // Shared with every repository gate. The bundler resolves its output
    // directory from NEXT_DIST_DIR, so the name cannot be enumerated here.
    ignores: IGNORED_GLOBS,
  },
];

export default eslintConfig;
