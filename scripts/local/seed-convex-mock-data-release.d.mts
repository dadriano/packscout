export function parseEnvironmentFile(contents: string): Record<string, string>;

export function requireLoopbackConvexUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string;

export function assertNoCloudDeployKey(
  environment: Readonly<Record<string, string | undefined>>,
): void;

export function assertLocalConvexDeployment(
  environment: Readonly<Record<string, string | undefined>>,
): void;

export function localCatalogReadCredential(
  environment: Readonly<Record<string, string | undefined>>,
): string | null;

export function readLocalConvexConfiguration(): Promise<{
  readonly childEnvironment: NodeJS.ProcessEnv;
  readonly publicUrl: string;
}>;

export function seedLocalMockDataRelease(): Promise<{
  readonly status: "created" | "unchanged";
  readonly repackCount: 6;
  readonly [key: string]: unknown;
}>;
