import type { PublicCollectible } from "@packscout/contracts";

/**
 * Identity formatting accepts both the full public collectible and the
 * bounded display projection carried by data_release_v3 desired-collectible
 * results, where the descriptor evidence fields are simply absent.
 */
export type CollectibleIdentityInput = Pick<
  PublicCollectible,
  "name" | "collectibleType"
> &
  Partial<
    Pick<
      PublicCollectible,
      | "year"
      | "brand"
      | "setOrSeries"
      | "cardNumber"
      | "referenceNumber"
      | "grade"
      | "grader"
    >
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
  const grader = collectible.grader ?? null;
  const grade = collectible.grade == null
    ? grader
    : `${grader ?? "Grade"} ${collectible.grade}`;
  return [
    collectibleTypeLabel(collectible.collectibleType),
    collectible.year == null ? null : String(collectible.year),
    collectible.brand ?? null,
    collectible.setOrSeries ?? null,
    collectible.cardNumber == null ? null : `Card #${collectible.cardNumber}`,
    collectible.referenceNumber == null
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
