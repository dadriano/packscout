import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicRepackActions } from "@packscout/contracts";
import {
  buildPublishedRepackHref,
  copyPublicPromoCode,
} from "./pack-actions.client";

type PublicRepackLink = NonNullable<PublicRepackActions["repackLink"]>;

const publishedLink: PublicRepackLink = {
  listingUrl:
    "https://packs.example/listing/alpha?keep=1&ref=old&ref=older#details",
  listingHost: "packs.example",
  referralParameters: [
    { name: "ref", value: "packscout" },
    { name: "utm_source", value: "packscout" },
  ],
};

test("builds the approved outbound URL with each referral parameter exactly once", () => {
  const result = buildPublishedRepackHref(publishedLink, "available");

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const url = new URL(result.href);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "packs.example");
  assert.equal(url.searchParams.get("keep"), "1");
  assert.deepEqual(url.searchParams.getAll("ref"), ["packscout"]);
  assert.deepEqual(url.searchParams.getAll("utm_source"), ["packscout"]);
  assert.equal(url.hash, "#details");
});

test("blocks every non-available, missing, unapproved, and malformed outbound action", () => {
  assert.deepEqual(buildPublishedRepackHref(undefined, "available"), {
    ok: false,
    code: "MISSING_LINK",
  });
  assert.deepEqual(buildPublishedRepackHref(publishedLink, "sold_out"), {
    ok: false,
    code: "SOLD_OUT",
  });
  assert.deepEqual(buildPublishedRepackHref(publishedLink, "unavailable"), {
    ok: false,
    code: "UNAVAILABLE",
  });
  assert.deepEqual(buildPublishedRepackHref(publishedLink, "unknown"), {
    ok: false,
    code: "AVAILABILITY_UNKNOWN",
  });
  assert.deepEqual(
    buildPublishedRepackHref(
      { ...publishedLink, listingUrl: "http://packs.example/listing/alpha" },
      "available",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      {
        ...publishedLink,
        listingUrl: "https://person:secret@packs.example/listing/alpha",
      },
      "available",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      { ...publishedLink, listingHost: "other.example" },
      "available",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      {
        ...publishedLink,
        listingUrl: "https://packs.example.attacker.test/listing/alpha",
      },
      "available",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      {
        ...publishedLink,
        listingUrl: "https://packs.example:8443/listing/alpha",
      },
      "available",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      { ...publishedLink, listingHost: "PACKS.EXAMPLE" } as PublicRepackLink,
      "available",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      {
        ...publishedLink,
        listingUrl: "https://sub.packs.example/listing/alpha",
        listingHost: "*.packs.example",
      } as PublicRepackLink,
      "available",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      {
        ...publishedLink,
        referralParameters: [
          { name: "ref", value: "one" },
          { name: "ref", value: "two" },
        ],
      } as PublicRepackLink,
      "available",
    ),
    { ok: false, code: "INVALID_REFERRAL_CONFIG" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      {
        ...publishedLink,
        referralParameters: [{ name: "ref", value: "  " }],
      } as PublicRepackLink,
      "available",
    ),
    { ok: false, code: "INVALID_REFERRAL_CONFIG" },
  );
  assert.deepEqual(
    buildPublishedRepackHref(
      {
        ...publishedLink,
        referralParameters: Array.from({ length: 9 }, (_, index) => ({
          name: `ref${index}`,
          value: "packscout",
        })),
      } as PublicRepackLink,
      "available",
    ),
    { ok: false, code: "INVALID_REFERRAL_CONFIG" },
  );
});

test("copies only the public promo code and returns a stable manual-copy fallback", async () => {
  const writes: string[] = [];
  const copied = await copyPublicPromoCode("SCOUT", async (value) => {
    writes.push(value);
  });

  assert.deepEqual(copied, { ok: true });
  assert.deepEqual(writes, ["SCOUT"]);
  assert.deepEqual(
    await copyPublicPromoCode(" SCOUT ", async (value) => {
      writes.push(value);
    }),
    { ok: true },
  );
  assert.equal(writes.at(-1), " SCOUT ", "copy text must never be normalized");
  assert.deepEqual(await copyPublicPromoCode("SCOUT", null), {
    ok: false,
    code: "CLIPBOARD_UNAVAILABLE",
  });
  assert.deepEqual(
    await copyPublicPromoCode("SCOUT", async () => {
      throw new Error("denied");
    }),
    { ok: false, code: "CLIPBOARD_UNAVAILABLE" },
  );
});
