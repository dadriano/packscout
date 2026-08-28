import type {
  PublicPackAvailability,
  PublicRepackActions,
} from "@packscout/contracts";
import { presentPackAvailability } from "@/lib/pack-availability-presentation";

type PublicRepackLink = NonNullable<PublicRepackActions["repackLink"]>;

export type OutboundRepackLinkResult =
  | { readonly ok: true; readonly href: string }
  | {
      readonly ok: false;
      readonly code:
        | "MISSING_LINK"
        | "UNAVAILABLE"
        | "AVAILABILITY_UNKNOWN"
        | "SOLD_OUT"
        | "UNAPPROVED_ORIGIN"
        | "INVALID_REFERRAL_CONFIG";
    };

export type PromoClipboardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "CLIPBOARD_UNAVAILABLE" };

export type ClipboardWriter = (text: string) => Promise<void>;

type OutboundRefusalCode = Extract<
  OutboundRepackLinkResult,
  { readonly ok: false }
>["code"];

/**
 * Names why a non-purchasable pack was refused, without deciding whether it
 * was refused — the shared presenter owns that decision. Any pack availability
 * state without its own refusal code reports the unknown-availability reason,
 * which is the honest reading of a state this build cannot interpret.
 */
function outboundRefusalCode(
  availability: PublicPackAvailability,
): OutboundRefusalCode {
  switch (availability) {
    case "sold_out":
      return "SOLD_OUT";
    case "unavailable":
      return "UNAVAILABLE";
    default:
      return "AVAILABILITY_UNKNOWN";
  }
}

export function buildPublishedRepackHref(
  repackLink: PublicRepackLink | undefined,
  availability: PublicPackAvailability,
): OutboundRepackLinkResult {
  // Fail closed. Only `available` may expose an outbound purchase link, so the
  // gate asks the shared presenter for permission rather than enumerating the
  // states it refuses: a pack availability state added after this code was
  // written is refused by default instead of falling into the allowed branch.
  // Promos are deliberately not gated here — the v3 contract governs them by
  // `actionAvailability` alone.
  if (!presentPackAvailability(availability).purchaseActionsAvailable) {
    return Object.freeze({
      ok: false,
      code: outboundRefusalCode(availability),
    });
  }
  if (!repackLink) {
    return Object.freeze({ ok: false, code: "MISSING_LINK" });
  }

  if (
    repackLink.listingUrl.length > 2_048 ||
    repackLink.listingHost.length === 0 ||
    repackLink.listingHost.length > 253 ||
    repackLink.listingHost !== repackLink.listingHost.toLowerCase() ||
    /[*/@?#]/.test(repackLink.listingHost)
  ) {
    return Object.freeze({ ok: false, code: "UNAPPROVED_ORIGIN" });
  }

  let listing: URL;
  let approvedOrigin: string;
  try {
    listing = new URL(repackLink.listingUrl);
    const approved = new URL(`https://${repackLink.listingHost}`);
    if (
      approved.host !== repackLink.listingHost ||
      approved.pathname !== "/" ||
      approved.search !== "" ||
      approved.hash !== ""
    ) {
      return Object.freeze({ ok: false, code: "UNAPPROVED_ORIGIN" });
    }
    approvedOrigin = approved.origin;
  } catch {
    return Object.freeze({ ok: false, code: "UNAPPROVED_ORIGIN" });
  }
  if (
    listing.protocol !== "https:" ||
    listing.username !== "" ||
    listing.password !== "" ||
    listing.origin !== approvedOrigin
  ) {
    return Object.freeze({ ok: false, code: "UNAPPROVED_ORIGIN" });
  }

  if (repackLink.referralParameters.length > 8) {
    return Object.freeze({ ok: false, code: "INVALID_REFERRAL_CONFIG" });
  }
  const referralNames = new Set<string>();
  for (const parameter of repackLink.referralParameters) {
    if (
      !/^[A-Za-z0-9._~-]{1,64}$/.test(parameter.name) ||
      parameter.value.trim().length === 0 ||
      parameter.value !== parameter.value.trim() ||
      parameter.value.length > 256 ||
      referralNames.has(parameter.name)
    ) {
      return Object.freeze({ ok: false, code: "INVALID_REFERRAL_CONFIG" });
    }
    referralNames.add(parameter.name);
    listing.searchParams.set(parameter.name, parameter.value);
  }

  return Object.freeze({ ok: true, href: listing.toString() });
}

function browserClipboardWriter(): ClipboardWriter | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  try {
    if (typeof navigator.clipboard?.writeText !== "function") return null;
    return navigator.clipboard.writeText.bind(navigator.clipboard);
  } catch {
    return null;
  }
}

export async function copyPublicPromoCode(
  code: string,
  writer: ClipboardWriter | null = browserClipboardWriter(),
): Promise<PromoClipboardResult> {
  if (!writer) {
    return Object.freeze({ ok: false, code: "CLIPBOARD_UNAVAILABLE" });
  }
  try {
    await writer(code);
    return Object.freeze({ ok: true });
  } catch {
    return Object.freeze({ ok: false, code: "CLIPBOARD_UNAVAILABLE" });
  }
}
