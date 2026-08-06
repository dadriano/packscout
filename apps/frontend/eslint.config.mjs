import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: [
      ".next/**",
      ".next-dev/**",
      ".next-build/**",
      ".next-dev-*/**",
      ".next-build-*/**",
    ],
  },
];

export default eslintConfig;
