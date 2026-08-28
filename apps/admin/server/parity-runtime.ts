import {
  judgeProviderParity,
  type CanonicalInspectionService,
  type CanonicalParityInput,
  type ProviderParity,
  type PublishedParityInput,
} from "@packscout/services";
import type { PrismaProviderPromotionFactsRepository } from "@packscout/database";
import type { PublishedCatalogReader } from "./published-catalog-reader.ts";

/**
 * Assembles one provider's parity, and the whole roster's, from cheap reads.
 *
 * The two sides fail independently. A published side that does not answer must
 * leave the canonical figures intact and read as unknown, because the whole
 * point of the surface is to be trusted when it says something is wrong — a
 * fabricated zero would read as catastrophic data loss.
 */

export interface ParityRuntime {
  summarize(organizationId: string): Promise<{
    providers: readonly ProviderParity[];
    publishedSideNote: string | null;
  }>;
  detail(input: {
    organizationId: string;
    platformKey: string;
  }): Promise<ProviderParity>;
}

export function createParityRuntime(dependencies: {
  canonical: Pick<
    CanonicalInspectionService,
    "listProviders" | "summarizeProvider"
  >;
  promotion: PrismaProviderPromotionFactsRepository;
  published: PublishedCatalogReader;
  deploymentKey: string;
}): ParityRuntime {
  async function publishedFor(
    platformKey: string,
  ): Promise<{ input: PublishedParityInput; note: string | null }> {
    try {
      const active = await dependencies.published.activeRelease(platformKey);
      switch (active.status) {
        case "no_active_manifest":
          return { input: { kind: "no_active_manifest" }, note: null };
        case "platform_not_referenced":
          return { input: { kind: "platform_not_referenced" }, note: null };
        case "release_missing":
          return {
            input: {
              kind: "release_missing",
              publicProviderReleaseId: active.publicProviderReleaseId,
            },
            note: null,
          };
        case "active":
          return {
            input: {
              kind: "active",
              publicProviderReleaseId: active.release.publicProviderReleaseId,
              lifecycle: active.release.lifecycle,
              providerReleaseFingerprint:
                active.release.providerReleaseFingerprint,
              dataAsOf: active.release.dataAsOf,
              counts: active.release.counts,
            },
            note: null,
          };
      }
    } catch (reason) {
      const detail =
        reason instanceof Error && "code" in reason
          ? String((reason as { code: unknown }).code)
          : "the product backend did not answer";
      return { input: { kind: "unreadable", detail }, note: detail };
    }
  }

  async function canonicalFor(input: {
    organizationId: string;
    platformKey: string;
    facts: Awaited<
      ReturnType<PrismaProviderPromotionFactsRepository["readFacts"]>
    >[number];
  }): Promise<CanonicalParityInput> {
    try {
      const summary = await dependencies.canonical.summarizeProvider({
        organizationId: input.organizationId,
        platformKey: input.platformKey,
      });
      return {
        kind: "read",
        kinds: summary.kinds,
        settledCheckpoint: input.facts.settledCheckpoint,
        sourceHeadCheckpoint: input.facts.sourceHeadCheckpoint,
        completedCheckpoint: input.facts.completedCheckpoint,
        completedProviderReleaseFingerprint:
          input.facts.completedProviderReleaseFingerprint,
        selectedProviderReleaseFingerprint:
          input.facts.selectedProviderReleaseFingerprint,
        selectedPublicProviderReleaseId:
          input.facts.selectedPublicProviderReleaseId,
      };
    } catch {
      return { kind: "unreadable", detail: "canonical data is unavailable" };
    }
  }

  return {
    async summarize(organizationId) {
      const providers = await dependencies.canonical.listProviders(
        organizationId,
      );
      const facts = await dependencies.promotion.readFacts({
        organizationId,
        deploymentKey: dependencies.deploymentKey,
        platformKeys: providers.map((provider) => provider.platformKey),
      });
      const factsByPlatform = new Map(
        facts.map((row) => [row.platformKey, row]),
      );

      let publishedSideNote: string | null = null;
      const results: ProviderParity[] = [];
      for (const provider of providers) {
        const platformKey = provider.platformKey;
        const providerFacts = factsByPlatform.get(platformKey);
        if (!providerFacts) continue;
        const [canonical, published] = await Promise.all([
          canonicalFor({
            organizationId,
            platformKey,
            facts: providerFacts,
          }),
          publishedFor(platformKey),
        ]);
        // Stated once for the whole summary rather than repeated per row.
        if (published.note && !publishedSideNote) {
          publishedSideNote = published.note;
        }
        results.push(
          judgeProviderParity({
            platformKey,
            canonical,
            published: published.input,
          }),
        );
      }
      return { providers: results, publishedSideNote };
    },

    async detail({ organizationId, platformKey }) {
      const facts = await dependencies.promotion.readFacts({
        organizationId,
        deploymentKey: dependencies.deploymentKey,
        platformKeys: [platformKey],
      });
      const providerFacts = facts[0];
      const [canonical, published] = await Promise.all([
        providerFacts
          ? canonicalFor({ organizationId, platformKey, facts: providerFacts })
          : Promise.resolve<CanonicalParityInput>({
              kind: "unreadable",
              detail: "no promotion record exists for this provider",
            }),
        publishedFor(platformKey),
      ]);
      return judgeProviderParity({
        platformKey,
        canonical,
        published: published.input,
      });
    },
  };
}
