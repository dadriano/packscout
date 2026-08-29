import type {
  EncryptedProviderCredential,
  ProviderCredentialCipher,
} from "./provider-credential-cipher.ts";

export interface ResolvedProviderDatabaseCredential {
  readonly username: string;
  readonly password: string;
}

function parseDatabaseCredential(value: string): ResolvedProviderDatabaseCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Provider database credential is invalid.");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",") !== "password,username"
  ) {
    throw new Error("Provider database credential is invalid.");
  }
  const { username, password } = parsed as Record<string, unknown>;
  if (
    typeof username !== "string"
    || username.length < 1
    || username.length > 128
    || typeof password !== "string"
    || password.length < 1
    || password.length > 4_096
    || /[\r\n\0]/u.test(username)
    || /[\r\n\0]/u.test(password)
  ) {
    throw new Error("Provider database credential is invalid.");
  }
  return Object.freeze({ username, password });
}

/** Converts one central encrypted DB credential into an ephemeral connection pair. */
export class CipherProviderDatabaseCredentialResolver {
  constructor(private readonly cipher: ProviderCredentialCipher) {}

  async resolve(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly credentialVersionId: string;
    readonly encryptedCredential: EncryptedProviderCredential;
  }): Promise<ResolvedProviderDatabaseCredential> {
    return parseDatabaseCredential(this.cipher.decrypt(
      input.encryptedCredential,
      {
        organizationId: input.organizationId,
        providerId: input.providerId,
        revisionId: input.credentialVersionId,
      },
    ));
  }
}
