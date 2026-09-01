import type { ProductUserProfile, ProductUserRecord } from "@packscout/contracts";
import type { ProductUserDirectoryReader } from "./product-user-directory.ts";

/** Display data only: never a source for admission or notification addresses. */
export interface ProductUserProfileReader {
  readProfile(subject: string): Promise<ProductUserProfile | null>;
}

/**
 * Adds provider profiles after the authoritative directory read. Only browser
 * display reads use these attributes; the notification lookup and every
 * mutation retain their original records and behavior.
 */
export function withProductUserProfiles(
  directory: ProductUserDirectoryReader,
  profiles: ProductUserProfileReader,
): ProductUserDirectoryReader {
  async function enrich<RecordType extends ProductUserRecord>(
    record: RecordType,
  ): Promise<RecordType> {
    let profile: ProductUserProfile | null = null;
    try {
      profile = await profiles.readProfile(record.subject);
    } catch {
      // Optional display data must not make the approval queue unavailable.
    }
    return { ...record, profile };
  }

  return {
    async listProductUsers(input) {
      const page = await directory.listProductUsers(input);
      return { ...page, items: await Promise.all(page.items.map(enrich)) };
    },
    async listProductUserAccessQueue(input) {
      const page = await directory.listProductUserAccessQueue(input);
      return { ...page, items: await Promise.all(page.items.map(enrich)) };
    },
    async getProductUserDetail(input) {
      const detail = await directory.getProductUserDetail(input);
      return { ...detail, user: await enrich(detail.user) };
    },
    getProductUserRecord: (input) => directory.getProductUserRecord(input),
    setProductUserStanding: (input) => directory.setProductUserStanding(input),
    countAwaitingReview: () => directory.countAwaitingReview(),
    decideProductUserAccess: (input) => directory.decideProductUserAccess(input),
  };
}
