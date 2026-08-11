import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicPackActions } from "@packscout/contracts";
import {
  buildPublishedPackHref,
  copyPublicPromoCode,
} from "./pack-actions.client";

type PublicPackLink = NonNullable<PublicPackActions["packLink"]>;

const publishedLink: PublicPackLink = {
  listingUrl:
    "https://packs.example/listing/alpha?keep=1&ref=old&ref=older#details",
  listingHost: "packs.example",
  referralParameters: [
    { name: "ref", value: "packscout" },
    { name: "utm_source", value: "packscout" },
  ],
};

test("builds the approved outbound URL with each referral parameter exactly once", () => {
  const result = buildPublishedPackHref(publishedLink, "active");

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

test("blocks missing, sold-out, unapproved, and malformed outbound actions", () => {
  assert.deepEqual(buildPublishedPackHref(undefined, "active"), {
    ok: false,
    code: "MISSING_LINK",
  });
  assert.deepEqual(buildPublishedPackHref(publishedLink, "sold_out"), {
    ok: false,
    code: "SOLD_OUT",
  });
  assert.deepEqual(
    buildPublishedPackHref(
      { ...publishedLink, listingUrl: "http://packs.example/listing/alpha" },
      "active",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      {
        ...publishedLink,
        listingUrl: "https://person:secret@packs.example/listing/alpha",
      },
      "active",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      { ...publishedLink, listingHost: "other.example" },
      "active",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      {
        ...publishedLink,
        listingUrl: "https://packs.example.attacker.test/listing/alpha",
      },
      "active",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      {
        ...publishedLink,
        listingUrl: "https://packs.example:8443/listing/alpha",
      },
      "active",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      { ...publishedLink, listingHost: "PACKS.EXAMPLE" } as PublicPackLink,
      "active",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      {
        ...publishedLink,
        listingUrl: "https://sub.packs.example/listing/alpha",
        listingHost: "*.packs.example",
      } as PublicPackLink,
      "active",
    ),
    { ok: false, code: "UNAPPROVED_ORIGIN" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      {
        ...publishedLink,
        referralParameters: [
          { name: "ref", value: "one" },
          { name: "ref", value: "two" },
        ],
      } as PublicPackLink,
      "active",
    ),
    { ok: false, code: "INVALID_REFERRAL_CONFIG" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      {
        ...publishedLink,
        referralParameters: [{ name: "ref", value: "  " }],
      } as PublicPackLink,
      "active",
    ),
    { ok: false, code: "INVALID_REFERRAL_CONFIG" },
  );
  assert.deepEqual(
    buildPublishedPackHref(
      {
        ...publishedLink,
        referralParameters: Array.from({ length: 9 }, (_, index) => ({
          name: `ref${index}`,
          value: "packscout",
        })),
      } as PublicPackLink,
      "active",
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
