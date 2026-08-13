import type { PublicCollectible } from "@packscout/contracts";

export type CollectibleIdentityInput = Pick<
  PublicCollectible,
  | "name"
  | "collectibleType"
  | "year"
  | "brand"
  | "setOrSeries"
  | "cardNumber"
  | "referenceNumber"
  | "grade"
  | "grader"
>;

function collectibleTypeLabel(value: PublicCollectible["collectibleType"]): string {
  return value
    .split("_")
    .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function formatCollectibleDescriptor(
  collectible: Omit<CollectibleIdentityInput, "name">,
): string {
  const grade = collectible.grade === null
    ? collectible.grader
    : `${collectible.grader ?? "Grade"} ${collectible.grade}`;
  return [
    collectibleTypeLabel(collectible.collectibleType),
    collectible.year === null ? null : String(collectible.year),
    collectible.brand,
    collectible.setOrSeries,
    collectible.cardNumber === null ? null : `Card #${collectible.cardNumber}`,
    collectible.referenceNumber === null
      ? null
      : `Reference ${collectible.referenceNumber}`,
    grade,
  ]
    .filter((value): value is string => value !== null && value !== "")
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
}

export function formatCollectibleIdentity(
  collectible: CollectibleIdentityInput,
): string {
  const descriptor = formatCollectibleDescriptor(collectible);
  return descriptor.length > 0
    ? `${collectible.name} · ${descriptor}`
    : collectible.name;
}
