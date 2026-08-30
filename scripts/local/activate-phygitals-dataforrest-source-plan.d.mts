export declare class PhygitalsDataforrestActivationError extends Error {
  readonly code: string;
  constructor(code: string);
}
export declare function assertPhygitalsDataforrestTokenAbsent(environment: NodeJS.ProcessEnv): void;
export declare function assertNoPhygitalsActivationArguments(argumentsList: readonly string[]): void;
export declare function readPhygitalsDataforrestActivationEnvironment(input: Readonly<{
  processEnvironment: NodeJS.ProcessEnv;
  fileEnvironment: Record<string, string>;
}>): Readonly<{
  centralDatabaseUrl: string;
  credentialKey: Uint8Array;
  credentialKeyVersion: number;
}>;
export declare function phygitalsDataforrestConfiguration(): Readonly<{ platform: "phygitals" }>;
export declare function safePhygitalsDataforrestActivationError(error: unknown): PhygitalsDataforrestActivationError;
