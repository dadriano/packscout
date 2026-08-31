#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuseBackfill } from "../local/provider-backfill-supervisor-policy.mts";
import { runContinuousCli, runContinuousPoller } from "../local/run-provider-continuous-poller.mts";
import { readClutchpacksProductionPollerSettings, revalidateClutchpacksProductionPollerSettings } from "./clutchpacks-production-poller-policy.mts";
import { assertClutchpacksProductionPollerArguments, createClutchpacksProductionPostHead,
  type ClutchpacksProductionPublisherModule } from "./clutchpacks-production-poller-runtime.mts";

const residentModuleRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
/** Native continuous argv/pins stay visible to the existing process census. */
export async function runClutchpacksProductionPollerCli(argv: readonly string[], signal: AbortSignal,
  output: { result(value: unknown): void; error(value: unknown): void },
  dependencies: { environment?: NodeJS.ProcessEnv; moduleRoot?: string; run?: typeof runContinuousPoller;
    loadPublisher?: (specifier: string) => Promise<ClutchpacksProductionPublisherModule> } = {}): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const moduleRoot = dependencies.moduleRoot ?? residentModuleRoot;
  return runContinuousCli(argv, signal, output, async args => {
    // Source-worker execution retains its established development environment.
    if (environment.NODE_ENV !== "development") refuseBackfill("CONTINUOUS_CLUTCHPACKS_ENVIRONMENT_INVALID");
    const settings = await readClutchpacksProductionPollerSettings(environment, moduleRoot);
    assertClutchpacksProductionPollerArguments(args, settings);
    const postHead = createClutchpacksProductionPostHead(settings, moduleRoot, args.mode === "--check-only", dependencies.loadPublisher, environment);
    return (dependencies.run ?? runContinuousPoller)(args, signal, { postHead, beforeSource: async sourceSignal => {
      if (sourceSignal.aborted) refuseBackfill("CONTINUOUS_POST_HEAD_ABORTED");
      if (environment.NODE_ENV !== "development") refuseBackfill("CONTINUOUS_CLUTCHPACKS_ENVIRONMENT_INVALID");
      await revalidateClutchpacksProductionPollerSettings(settings, moduleRoot, environment);
      if (sourceSignal.aborted) refuseBackfill("CONTINUOUS_POST_HEAD_ABORTED");
    } });
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
  void runClutchpacksProductionPollerCli(process.argv.slice(2), stop.signal, {
    result: value => { process.stdout.write(`${JSON.stringify(value)}\n`); },
    error: value => { process.stderr.write(`${JSON.stringify(value)}\n`); },
  }).then(code => { process.exitCode = code; });
}
