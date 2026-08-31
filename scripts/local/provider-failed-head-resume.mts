#!/usr/bin/env node
import { operatorContinuationDirectInvocation } from "./provider-operator-continuation.mts";
import { parsePausedHeadArguments, readPrivateProviderOperatorFile, runReviewedProviderHeadControl } from "./provider-paused-head-resume.mts";
import { PausedHeadError } from "./provider-paused-head-policy.mts";
import { FailedHeadError, failedHeadReviewSchema } from "./provider-failed-head-policy.mts";
import { createFailedHeadContinuation } from "./provider-failed-head-control.mts";
export const parseFailedHeadArguments = parsePausedHeadArguments;
export async function readFailedHeadReview(file: string) {
  const bytes = await readPrivateProviderOperatorFile(file, 24_576);
  try { return failedHeadReviewSchema.parse(JSON.parse(bytes.toString("utf8"))); }
  finally { bytes.fill(0); }
}
export function runFailedHeadContinuation(args: ReturnType<typeof parseFailedHeadArguments>) {
  return runReviewedProviderHeadControl(args, readFailedHeadReview, createFailedHeadContinuation, "already_queued");
}
if (await operatorContinuationDirectInvocation(process.argv[1], import.meta.url)) {
  Promise.resolve().then(() => runFailedHeadContinuation(parseFailedHeadArguments(process.argv.slice(2))))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof FailedHeadError || error instanceof PausedHeadError
        ? error.code : "FAILED_HEAD_OPERATION_FAILED" })}\n`); process.exitCode = 1;
    });
}
