import { AdminApiError } from "../../api/client";

/**
 * Failure copy for the product-user surfaces, derived from the admin's own
 * stable codes. The product-backend integration never reports a raw upstream
 * error, so there is nothing here to restate beyond what the admin service
 * already decided to say.
 */
export interface DirectoryFailure {
  readonly title: string;
  readonly description: string;
  /** False when retrying the same request cannot help. */
  readonly retryable: boolean;
}

/** Which read failed, so the generic copy names the right thing. */
export type DirectoryScope = "directory" | "user";

const GENERIC_TITLE: Record<DirectoryScope, string> = {
  directory: "The product-user directory could not be loaded.",
  user: "This user could not be loaded.",
};

export function describeDirectoryFailure(
  error: unknown,
  scope: DirectoryScope = "directory",
): DirectoryFailure {
  if (error instanceof AdminApiError) {
    if (error.code === "PRODUCT_USER_DIRECTORY_UNCONFIGURED") {
      return {
        title: "The product-user directory is not connected.",
        description:
          "This admin service has no configured connection to the product backend, so sign-ups cannot be listed. Nothing has been changed; configure the integration on the server and reload.",
        retryable: false,
      };
    }
    if (error.code === "PRODUCT_USER_NOT_FOUND" || error.status === 404) {
      return {
        title: "This user is not in the directory.",
        description:
          "The sign-up record for this account is gone or was never recorded, so there is nothing to inspect. Nothing has been changed.",
        retryable: false,
      };
    }
    if (error.code === "INVALID_PRODUCT_USER_CURSOR") {
      return {
        title: "This page of the directory is no longer valid.",
        description:
          "The directory moved on while you were paging through it. Return to the first page to continue.",
        retryable: false,
      };
    }
    if (error.status === 429) {
      return {
        title: "Too many directory requests.",
        description: "Wait a moment before searching or paging again.",
        retryable: true,
      };
    }
    return {
      title: GENERIC_TITLE[scope],
      description: `${error.message} Nothing has been changed.`,
      retryable: true,
    };
  }
  return {
    title: GENERIC_TITLE[scope],
    description:
      "PackScout Admin is temporarily unavailable. Nothing has been changed.",
    retryable: true,
  };
}
