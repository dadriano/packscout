export function normalizeProtectedPublicationFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const PROTECTED_PUBLICATION_FIELD_FRAGMENTS = [
  "apikey",
  "credential",
  "internalrunid",
  "organizationid",
  "orgid",
  "password",
  "providerpayload",
  "providerresponse",
  "quarantine",
  "rawpayload",
  "rawresponse",
  "secret",
  "sourcepayload",
  "sourceresponse",
  "tenantid",
  "token",
] as const;

function containsProtectedPublicationFieldFragment(
  key: string,
  normalizedKey: string,
): boolean {
  const lexicalTokens = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter((token) => token.length > 0);
  return lexicalTokens.includes("actor") ||
    PROTECTED_PUBLICATION_FIELD_FRAGMENTS.some((fragment) =>
      normalizedKey.includes(fragment)
    );
}

export function containsNormalizedProtectedPublicationField(
  value: unknown,
  protectedFields: ReadonlySet<string>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((nested) =>
      containsNormalizedProtectedPublicationField(nested, protectedFields)
    );
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) => {
      const normalizedKey = normalizeProtectedPublicationFieldKey(key);
      return protectedFields.has(normalizedKey) ||
        containsProtectedPublicationFieldFragment(key, normalizedKey) ||
        containsNormalizedProtectedPublicationField(nested, protectedFields);
    },
  );
}
