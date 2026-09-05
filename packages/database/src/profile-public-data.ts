import { assertPublicPackCatalogBytes, assertPublicCatalogText, assertPublicCatalogUrl } from "@packscout/contracts";
import { sharedInvariant } from "./central-profile-publication-context.ts";

/** Scan all final profile text, including derived search text and decoded URL parameters. */
export function assertProfilePublicData(value: unknown): void {
  try { assertPublicPackCatalogBytes(value); } catch { sharedInvariant(false, "SHARED_INPUT_INVALID"); }
  const visit = (part: unknown): void => {
    if (Array.isArray(part)) { part.forEach(visit); return; }
    if (typeof part === "object" && part !== null) { Object.values(part).forEach(visit); return; }
    if (typeof part !== "string") return;
    const text = part.normalize("NFKC");
    try {
      assertPublicCatalogText(text);
      for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) assertPublicCatalogUrl(match[0]);
    } catch { sharedInvariant(false, "SHARED_INPUT_INVALID"); }
  };
  visit(value);
}
