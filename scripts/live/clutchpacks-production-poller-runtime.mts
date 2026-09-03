import path from "node:path";
import { pathToFileURL } from "node:url";
import { backfillDigest, refuseBackfill, ProviderBackfillSupervisorError } from "../local/provider-backfill-supervisor-policy.mts";
import type { ContinuousPostHead, ContinuousPostHeadRegistration } from "../local/provider-continuous-post-head.mts";
import type { parseContinuousArguments } from "../local/run-provider-continuous-poller.mts";
import { clutchpacksProductionPublisherModule, revalidateClutchpacksProductionPollerSettings,
  type ClutchpacksProductionPollerSettings } from "./clutchpacks-production-poller-policy.mts";

type ContinuousArguments = ReturnType<typeof parseContinuousArguments>;
export interface ClutchpacksProductionPublisherOptions {
  head: ContinuousPostHead;
  baseSourceConfig: { path: string; sha256: string };
  artifactDirectory: string;
  publisherWorktree: string;
  expectedPublisherCommit: string;
  expectedResidentAuthorityDigest: string;
  signal: AbortSignal;
  timeoutMs: number;
}
export interface ClutchpacksProductionPublisherModule {
  publishClutchpacksProductionPostHead(input: ClutchpacksProductionPublisherOptions): Promise<unknown>;
}
export function assertClutchpacksProductionPollerArguments(args: ContinuousArguments,
  settings: ClutchpacksProductionPollerSettings): void {
  if (args.bootstrapBackfill || args.pins.providerKey !== "clutchpacks" ||
    backfillDigest(args.pins) !== backfillDigest(settings.policy.pins) ||
    backfillDigest(args.cadence) !== backfillDigest(settings.policy.cadence)) {
    refuseBackfill("CONTINUOUS_CLUTCHPACKS_ARGUMENTS_INVALID");
  }
}
/** The policy fingerprint is an exact file hash, not a caller-provided label. */
export function createClutchpacksProductionPostHead(settings: ClutchpacksProductionPollerSettings,
  residentModuleRoot: string, checkOnly: boolean,
  load: (specifier: string) => Promise<ClutchpacksProductionPublisherModule> = specifier => import(specifier),
  environment: NodeJS.ProcessEnv = process.env,
): ContinuousPostHeadRegistration {
  const policy = settings.policy;
  return Object.freeze({ policyFingerprint: settings.fingerprint, timeoutMilliseconds: policy.timeoutMilliseconds,
    async run(head: ContinuousPostHead, signal: AbortSignal) {
      try {
        if (checkOnly) refuseBackfill("CONTINUOUS_CLUTCHPACKS_CHECK_ONLY");
        if (environment.NODE_ENV !== "development") refuseBackfill("CONTINUOUS_CLUTCHPACKS_ENVIRONMENT_INVALID");
        if (signal.aborted) refuseBackfill("CONTINUOUS_POST_HEAD_ABORTED");
        if (head.providerId !== policy.pins.providerId || head.configId !== policy.pins.configId ||
          head.authorityDigest !== policy.expectedResidentAuthorityDigest) refuseBackfill("CONTINUOUS_CLUTCHPACKS_HEAD_CHANGED");
        await revalidateClutchpacksProductionPollerSettings(settings, residentModuleRoot, environment);
        if (signal.aborted) refuseBackfill("CONTINUOUS_POST_HEAD_ABORTED");
        const publisher = await load(pathToFileURL(path.join(policy.publisher.checkout, clutchpacksProductionPublisherModule)).href);
        if (typeof publisher.publishClutchpacksProductionPostHead !== "function") refuseBackfill("CONTINUOUS_CLUTCHPACKS_PUBLISHER_INVALID");
        if (signal.aborted) refuseBackfill("CONTINUOUS_POST_HEAD_ABORTED");
        const result = await publisher.publishClutchpacksProductionPostHead({ head, baseSourceConfig: policy.baseSourceConfig,
          artifactDirectory: policy.artifactDirectory, publisherWorktree: policy.publisher.checkout,
          expectedPublisherCommit: policy.publisher.commit, expectedResidentAuthorityDigest: policy.expectedResidentAuthorityDigest,
          signal, timeoutMs: policy.timeoutMilliseconds });
        if (signal.aborted) refuseBackfill("CONTINUOUS_POST_HEAD_ABORTED");
        if (result === null || typeof result !== "object" ||
          Object.getOwnPropertyDescriptor(result, "status")?.value !== "verified") refuseBackfill("CONTINUOUS_CLUTCHPACKS_PUBLICATION_UNVERIFIED");
      } catch (error) {
        if (error instanceof ProviderBackfillSupervisorError) throw error;
        refuseBackfill("CONTINUOUS_CLUTCHPACKS_PUBLICATION_FAILED");
      }
    } });
}
