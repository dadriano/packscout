import type { PublicPackAvailability } from "@packscout/contracts";

export type PackAvailabilityPresentation = Readonly<{
  label: "Available" | "Unavailable" | "Availability unknown" | "Sold out";
  description: string;
  purchaseActionsAvailable: boolean;
}>;

const presentations = Object.freeze({
  available: Object.freeze({
    label: "Available",
    description: "The platform currently presents this pack as available.",
    purchaseActionsAvailable: true,
  }),
  unavailable: Object.freeze({
    label: "Unavailable",
    description:
      "The platform does not currently present this pack as available. This does not assert that it sold out.",
    purchaseActionsAvailable: false,
  }),
  unknown: Object.freeze({
    label: "Availability unknown",
    description: "PackScout does not have current availability evidence for this pack.",
    purchaseActionsAvailable: false,
  }),
  sold_out: Object.freeze({
    label: "Sold out",
    description: "An authoritative source explicitly reports this pack as sold out.",
    purchaseActionsAvailable: false,
  }),
} satisfies Readonly<Record<PublicPackAvailability, PackAvailabilityPresentation>>);

export function presentPackAvailability(
  availability: PublicPackAvailability,
): PackAvailabilityPresentation {
  return presentations[availability];
}
