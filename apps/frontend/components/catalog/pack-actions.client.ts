import type { PublicPackActions } from "@packscout/contracts";

type PublicPackLink = NonNullable<PublicPackActions["packLink"]>;

export type OutboundPackLinkResult =
  | { readonly ok: true; readonly href: string }
  | {
      readonly ok: false;
      readonly code:
        | "MISSING_LINK"
        | "SOLD_OUT"
        | "UNAPPROVED_ORIGIN"
        | "INVALID_REFERRAL_CONFIG";
    };

export type PromoClipboardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "CLIPBOARD_UNAVAILABLE" };

export type ClipboardWriter = (text: string) => Promise<void>;

export function buildPublishedPackHref(
  packLink: PublicPackLink | undefined,
  availability: "active" | "sold_out",
): OutboundPackLinkResult {
  if (availability === "sold_out") {
    return Object.freeze({ ok: false, code: "SOLD_OUT" });
  }
  if (!packLink) {
    return Object.freeze({ ok: false, code: "MISSING_LINK" });
  }

  if (
    packLink.listingUrl.length > 2_048 ||
    packLink.listingHost.length === 0 ||
    packLink.listingHost.length > 253 ||
    packLink.listingHost !== packLink.listingHost.toLowerCase() ||
    /[*/@?#]/.test(packLink.listingHost)
  ) {
    return Object.freeze({ ok: false, code: "UNAPPROVED_ORIGIN" });
  }

  let listing: URL;
  let approvedOrigin: string;
  try {
    listing = new URL(packLink.listingUrl);
    const approved = new URL(`https://${packLink.listingHost}`);
    if (
      approved.host !== packLink.listingHost ||
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

  if (packLink.referralParameters.length > 8) {
    return Object.freeze({ ok: false, code: "INVALID_REFERRAL_CONFIG" });
  }
  const referralNames = new Set<string>();
  for (const parameter of packLink.referralParameters) {
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
