export interface PromotionJobEvaluatorWatchdogConfiguration {
  readonly databaseUrl: string;
  readonly systemSink: Readonly<{
    baseUrl: string;
    bearerToken: Uint8Array;
    timeoutMilliseconds: number;
  }>;
}

export class PromotionJobEvaluatorWatchdogConfigurationError extends Error {
  readonly code = "PROMOTION_JOB_EVALUATOR_WATCHDOG_CONFIGURATION_INVALID";

  constructor() {
    super("Promotion job evaluator watchdog configuration is invalid.");
    this.name = "PromotionJobEvaluatorWatchdogConfigurationError";
  }
}

const FORBIDDEN_AUTHORITY_KEYS = [
  "PACKSCOUT_DATABASE_URL",
  "PACKSCOUT_CENTRAL_DATABASE_URL",
  "PACKSCOUT_PROVIDER_DATABASE_URL",
  "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
  "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
  "PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS",
  "PACKSCOUT_PROMOTION_PROVIDER_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_KEY_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_KEY_ID",
  "PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_PROOF_TOKEN_BASE64",
  "PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64",
] as const;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function invalid(): never {
  throw new PromotionJobEvaluatorWatchdogConfigurationError();
}

function databaseUrl(value: string | undefined): string {
  if (!value || value.length > 4_096 || /[\r\n\0]/u.test(value)) invalid();
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.hostname || parsed.pathname.length < 2 || parsed.hash
    ) invalid();
    return parsed.toString();
  } catch {
    return invalid();
  }
}

function webhookOrigin(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n\0]/u.test(value)) invalid();
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || !parsed.hostname || parsed.username
      || parsed.password || parsed.pathname !== "/" || parsed.search
      || parsed.hash
    ) invalid();
    return parsed.origin;
  } catch {
    return invalid();
  }
}

function token(value: string | undefined): Uint8Array {
  if (!value || !BASE64_PATTERN.test(value)) invalid();
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value || bytes.byteLength < 32
    || bytes.byteLength > 128
  ) invalid();
  return new Uint8Array(bytes);
}

function timeout(value: string | undefined): number {
  const resolved = value ?? "10000";
  if (!/^[1-9][0-9]*$/u.test(resolved)) invalid();
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 60_000) {
    invalid();
  }
  return parsed;
}

/**
 * The watchdog requires its own read-only central credential. In particular,
 * it refuses the evaluator's central credential and every provider-routing or
 * publication authority variable.
 */
export function readPromotionJobEvaluatorWatchdogConfiguration(
  environment: NodeJS.ProcessEnv,
): PromotionJobEvaluatorWatchdogConfiguration {
  if (
    !["development", "production", "test"].includes(
      environment.NODE_ENV ?? "",
    )
    || FORBIDDEN_AUTHORITY_KEYS.some((key) => environment[key] !== undefined)
  ) invalid();
  return Object.freeze({
    databaseUrl: databaseUrl(
      environment.PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL,
    ),
    systemSink: Object.freeze({
      baseUrl: webhookOrigin(
        environment.PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL,
      ),
      bearerToken: token(
        environment.PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64,
      ),
      timeoutMilliseconds: timeout(
        environment.PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TIMEOUT_MS,
      ),
    }),
  });
}
