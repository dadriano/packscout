type LocalAccessEnvironment = Readonly<{
  NODE_ENV?: string;
  PACKSCOUT_LOCAL_ACCESS_BYPASS?: string;
  PACKSCOUT_FRONTEND_HOST?: string;
}>;

/** Catalog preview only: this never supplies an identity or backend token. */
export function localAccessBypassEnabled(
  environment: LocalAccessEnvironment,
  requestHost: string | null,
): boolean {
  if (
    environment.NODE_ENV !== "development" ||
    environment.PACKSCOUT_LOCAL_ACCESS_BYPASS !== "1" ||
    !["127.0.0.1", "localhost", "::1"].includes(
      environment.PACKSCOUT_FRONTEND_HOST ?? "",
    )
  ) {
    return false;
  }

  // Exact loopback authorities only; no suffixes, userinfo, or URL paths.
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/.exec(
    requestHost ?? "",
  );
  if (match === null) return false;
  return match[1] === undefined ||
    (Number(match[1]) > 0 && Number(match[1]) <= 65535);
}
