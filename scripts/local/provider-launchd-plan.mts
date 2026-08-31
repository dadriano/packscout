import path from "node:path";
import { backfillPinsSchema, refuseBackfill, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import { validatedContinuousCadence, type ContinuousCadence } from "./provider-continuous-cadence.mts";

function absolutePath(value: string): string {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value)) refuseBackfill("CONTINUOUS_LAUNCHD_PATH_INVALID");
  return path.normalize(value);
}
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** Pure plan: the integration operator verifies paths/ownership and installs it.
 * No launchctl, file writes, subprocesses, DB reads, or inherited secret env. */
export function createProviderLaunchdPlan(input: { pins: BackfillPins; checkoutRoot: string; nodeExecutable: string;
  logPath: string; bootstrapBackfill: boolean; platform?: string; cadence?: ContinuousCadence }) {
  if ((input.platform ?? process.platform) !== "darwin") refuseBackfill("CONTINUOUS_LAUNCHD_MACOS_REQUIRED");
  const pins = backfillPinsSchema.parse(input.pins);
  const cadence = validatedContinuousCadence(input.cadence);
  if (input.bootstrapBackfill && cadence.kind !== "central") refuseBackfill("CONTINUOUS_BOOTSTRAP_POLICY_UNSUPPORTED");
  const root = absolutePath(input.checkoutRoot); const node = absolutePath(input.nodeExecutable);
  const log = absolutePath(input.logPath); const label = `com.packscout.provider-import.${pins.providerKey}`;
  const arguments_ = [node, "--import", "tsx", path.join(root, "scripts/local/run-provider-continuous-poller.mts"),
    "--run", "--launchd", ...(input.bootstrapBackfill ? ["--bootstrap-backfill"] : []),
    "--organization-id", pins.organizationId, "--provider-id", pins.providerId, "--provider-key", pins.providerKey,
    "--config-id", pins.configId, "--initial-run-id", pins.initialRunId, "--operation-id", pins.operationId,
    "--operator-id", pins.operatorId,
    ...(cadence.kind === "operator_interval" ? ["--poll-interval-seconds", String(cadence.intervalSeconds)] : [])];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${arguments_.map(value => `<string>${escapeXml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${escapeXml(root)}</string>
<key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>development</string>
<key>PATH</key><string>${escapeXml(`${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>60</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${escapeXml(log)}</string>
<key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict></plist>
`;
  return { label, arguments: arguments_, workingDirectory: root, logPath: log, plist, cadence,
    restartPolicy: "unexpected_exit_only" as const };
}
