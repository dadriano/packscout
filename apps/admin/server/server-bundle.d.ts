declare module "*.bundle.mjs" {
  const app: import("express").Express;

  export default app;
}
