import { readDatabaseRuntimePolicy } from "@packscout/database";
import { ProviderManualImportLocalError } from "./provider-manual-import-local-runtime.ts";

/** The local worker may explicitly use remote development databases, never implicit destinations. */
export function readProviderManualImportDatabaseConfiguration(environment: NodeJS.ProcessEnv) {
  try {
    if (environment.NODE_ENV === "production") throw new TypeError("Local worker requires development.");
    const databaseUrl = environment.PACKSCOUT_CENTRAL_DATABASE_URL?.trim() ?? "";
    const runtimePolicy = readDatabaseRuntimePolicy(environment);
    runtimePolicy.assertCentralDatabaseUrl(databaseUrl);
    return { centralDatabaseUrl: new URL(databaseUrl).toString(), runtimePolicy };
  } catch {
    throw new ProviderManualImportLocalError("PROVIDER_IMPORT_CONFIGURATION_INVALID");
  }
}
