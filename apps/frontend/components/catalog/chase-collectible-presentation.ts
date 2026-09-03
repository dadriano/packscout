import type {
  DesiredCollectibleRepackMatchV3,
  PublicCollectibleDisplay,
} from "@packscout/contracts";
import {
  formatCollectibleDescriptor,
  formatCollectibleIdentity,
  type CollectibleIdentityInput,
} from "@/lib/collectible-identity";
import { getPublicReasonCopy } from "@/lib/metric-vocabulary";
import {
  formatMoneyMinorUnits,
  presentRepackPrice,
} from "@/lib/packscout-ev-presentation";
import { presentChaseMatchEvidence } from "./pack-inspector-presentation";

const VALUATION_TYPE_LABEL = Object.freeze({
  market_estimate: "Market estimate",
  vendor_reported: "Vendor reported",
  last_sale: "Last sale",
  appraisal: "Appraisal",
});

export type ChaseCollectiblePresentation = Readonly<{
  name: string;
  identity: string;
  descriptor: string;
  image: PublicCollectibleDisplay["primaryImage"];
  valuationLabel: string;
  valuationTypeLabel: string | null;
  accessibleLabel: string;
}>;

export type ChasePackMatchPresentation = Readonly<{
  publicRepackId: string;
  name: string;
  vendorDisplayName: string;
  priceLabel: string;
  evidenceLabel: string;
  matchConfidenceLabel: string;
  accessibleLabel: string;
}>;

export function presentCollectibleValuation(
  valuation: PublicCollectibleDisplay["valuation"],
): Readonly<{
  displayValue: string;
  typeLabel: string | null;
  accessibleLabel: string;
}> {
  if (valuation === null) {
    const reasonCopy = getPublicReasonCopy("VALUATION_UNAVAILABLE");
    return Object.freeze({
      displayValue: "Unavailable",
      typeLabel: null,
      accessibleLabel: `Market value unavailable. ${reasonCopy}`,
    });
  }
  const typeLabel = VALUATION_TYPE_LABEL[valuation.valuationType];
  const money = valuation.displayMoney ??
    (valuation.usdComparison.status === "available"
      ? valuation.usdComparison.value
      : null);
  if (money === null) {
    const reasonCopy = getPublicReasonCopy(
      valuation.usdComparison.status === "unavailable"
        ? valuation.usdComparison.reason
        : "VALUATION_UNAVAILABLE",
    );
    return Object.freeze({
      displayValue: "Unavailable",
      typeLabel,
      accessibleLabel: `Market value unavailable. ${reasonCopy} ${typeLabel}.`,
    });
  }
  const displayValue = formatMoneyMinorUnits(money);
  return Object.freeze({
    displayValue,
    typeLabel,
    accessibleLabel: `Market value ${displayValue}. ${typeLabel}.`,
  });
}

export function presentChaseCollectible(input: Readonly<{
  collectible: PublicCollectibleDisplay | null;
  identity?: CollectibleIdentityInput;
}>): ChaseCollectiblePresentation {
  const identitySource = input.identity ?? input.collectible;
  const name = identitySource?.name ?? input.collectible?.name ?? "Desired chase";
  const descriptor = identitySource
    ? formatCollectibleDescriptor(identitySource)
    : input.collectible
      ? formatCollectibleDescriptor(input.collectible)
      : "";
  const identity = identitySource
    ? formatCollectibleIdentity(identitySource)
    : name;
  const valuation = presentCollectibleValuation(
    input.collectible?.valuation ?? null,
  );
  return Object.freeze({
    name,
    identity,
    descriptor,
    image: input.collectible?.primaryImage ?? null,
    valuationLabel: valuation.displayValue,
    valuationTypeLabel: valuation.typeLabel,
    accessibleLabel: `${identity}. ${valuation.accessibleLabel}`,
  });
}

export function presentChasePackMatch(
  match: DesiredCollectibleRepackMatchV3,
): ChasePackMatchPresentation {
  const price = presentRepackPrice(match.repack.price);
  const evidence = presentChaseMatchEvidence(match.chase);
  const priceLabel = price.availability === "available"
    ? price.displayValue
    : "Price unavailable";
  return Object.freeze({
    publicRepackId: match.repack.publicRepackId,
    name: match.repack.name,
    vendorDisplayName: match.repack.vendorDisplayName,
    priceLabel,
    evidenceLabel: evidence.evidenceLabel,
    matchConfidenceLabel: evidence.matchConfidenceLabel,
    accessibleLabel: `${match.repack.name}, offered by ${match.repack.vendorDisplayName}. ${price.accessibleLabel} ${evidence.accessibleLabel}`,
  });
}

export function presentChasePackListSummary(
  shown: number,
  total: number,
): string {
  if (total === 0) return "No published packs currently include this chase.";
  if (shown === total) {
    return total === 1 ? "1 matching pack" : `${total} matching packs`;
  }
  return `Showing ${shown} of ${total} matching packs`;
}

export function presentChaseInspectStatus(
  status: "loading" | "failed" | "missing" | "ready",
): string {
  if (status === "loading") return "Loading chase details…";
  if (status === "missing") return "This chase is no longer available.";
  if (status === "failed") return "Chase details are temporarily unavailable.";
  return "";
}
