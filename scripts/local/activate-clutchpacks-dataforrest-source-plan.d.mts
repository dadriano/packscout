export class ClutchpacksDataforrestActivationError extends Error {
  readonly code: string;
  constructor(code: string);
}

export function takeClutchpacksDataforrestToken(
  environment: Record<string, string | undefined>,
): string;

export function takeOptionalClutchpacksDataforrestToken(
  environment: Record<string, string | undefined>,
): string | null;

export function assertNoClutchpacksActivationArguments(
  argumentsList: readonly string[],
): void;

export function assertDataforrestTokenAbsentFromFileEnvironment(
  environment: Record<string, string | undefined>,
): void;

export function readClutchpacksDataforrestActivationEnvironment(input: {
  readonly processEnvironment: Record<string, string | undefined>;
  readonly fileEnvironment: Record<string, string>;
}): Readonly<{
  centralDatabaseUrl: string;
  providerDatabaseUrl: string;
  providerId: string;
  providerKey: "clutchpacks";
  credentialKey: Uint8Array;
  credentialKeyVersion: number;
}>;

export function clutchpacksDataforrestConfiguration(): Readonly<{
  platform: "clutchpacks";
}>;

export function safeClutchpacksDataforrestActivationError(
  error: unknown,
): ClutchpacksDataforrestActivationError;

export function safeClutchpacksDataforrestSnapshotError(
  error: unknown,
): ClutchpacksDataforrestActivationError;
