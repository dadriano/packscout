import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClutchpacksPackMembershipV1 } from "./clutchpacks-pack-membership-v1.ts";
import { normalizedPackMembershipV1Schema } from "./provider-pack-membership-v1.ts";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const card = (n: number) => ({ id: id(n), title: `Card ${n}`,
  front_image_url: `https://d18ez2bunk7yz0.cloudfront.net/cards/medium-images/${id(n)}.jpg` });
function source() {
  return { collection_id: id(1), status: "active", sold_out: false, directly_purchasable: true,
    series_hits: [{ ...card(999), current_price: "$130,000" }],
    price_bucket_odds: [
      { bucket_id: id(10), drawable_count: 1, preview_cards: [card(100)], has_more: false, pool_cards: [card(999)] },
      { bucket_id: id(11), drawable_count: 2, preview_cards: [card(101), card(102)], has_more: false },
    ] };
}

test("one complete native response preserves pack-specific previews without series hits or invented item values", () => {
  const parsed = parseClutchpacksPackMembershipV1(source());
  assert.deepEqual(parsed?.membership, { schemaVersion: "normalized_pack_membership_v1",
    providerPackRecordId: id(1),
    sourceKey: "clutchpacks:price_bucket_odds:v1", completeness: "complete", items: [
      { providerRecordId: id(100), displayOrder: 0 }, { providerRecordId: id(101), displayOrder: 1 },
      { providerRecordId: id(102), displayOrder: 2 },
    ] });
  assert.deepEqual(parsed?.cards[0], { providerRecordId: id(100), title: "Card 100", imageUrl: card(100).front_image_url });
  assert.equal(parsed?.cards.length, 3);
  assert.deepEqual(parsed?.availability, { status: "active", soldOut: false, directlyPurchasable: true });
});

test("has_more and count disagreement preserve partial evidence, while missing arrays remain unknown", () => {
  const paged = source();
  paged.price_bucket_odds[1]!.has_more = true;
  paged.price_bucket_odds[1]!.drawable_count = 3;
  assert.equal(parseClutchpacksPackMembershipV1(paged)?.membership.completeness, "partial");
  paged.price_bucket_odds[1]!.has_more = false;
  assert.equal(parseClutchpacksPackMembershipV1(paged)?.membership.completeness, "partial");
  assert.equal(parseClutchpacksPackMembershipV1({ collection_id: id(1) }), null);
  assert.equal(parseClutchpacksPackMembershipV1({ price_bucket_odds: null }), null);
  assert.equal(parseClutchpacksPackMembershipV1({ ...source(), price_bucket_odds: [] })?.membership.completeness, "partial");
});

test("restocking remains explicit despite purchase booleans, and older omitted status stays unknown", () => {
  const restocking = { ...source(), status: "restocking" };
  assert.deepEqual(parseClutchpacksPackMembershipV1(restocking)?.availability,
    { status: "restocking", soldOut: false, directlyPurchasable: true });
  const legacy: Record<string, unknown> = source();
  delete legacy.status;
  delete legacy.directly_purchasable;
  assert.equal(parseClutchpacksPackMembershipV1(legacy)?.availability, null);
  const envelopeIdentified = { ...legacy };
  delete envelopeIdentified.collection_id;
  assert.equal(parseClutchpacksPackMembershipV1(envelopeIdentified)?.providerRecordId, null);
  assert.equal(parseClutchpacksPackMembershipV1(envelopeIdentified)?.membership.providerPackRecordId, null);
  assert.equal(parseClutchpacksPackMembershipV1(envelopeIdentified)?.membership.items.length, 3);
  assert.throws(() => parseClutchpacksPackMembershipV1({ ...source(), status: "future_unknown_status" }), /invalid_evidence/u);
  assert.throws(() => parseClutchpacksPackMembershipV1({ ...legacy, status: "active" }), /invalid_evidence/u);
});

test("normalized membership retains embedded pack identity and requires explicit unknown identity", () => {
  const membership = parseClutchpacksPackMembershipV1(source())!.membership;
  assert.equal(membership.providerPackRecordId, id(1));
  assert.equal(normalizedPackMembershipV1Schema.parse({ ...membership, providerPackRecordId: null }).providerPackRecordId, null);
  const withoutIdentity: Record<string, unknown> = { ...membership };
  delete withoutIdentity.providerPackRecordId;
  assert.equal(normalizedPackMembershipV1Schema.safeParse(withoutIdentity).success, false);
  for (const providerPackRecordId of ["", "   ", 1, "x".repeat(501)]) {
    assert.equal(normalizedPackMembershipV1Schema.safeParse({ ...membership, providerPackRecordId }).success, false);
  }
});

test("explicit zero-count buckets have an empty complete preview; malformed or contradictory counts fail", () => {
  const empty = source();
  empty.price_bucket_odds = [{ bucket_id: id(10), drawable_count: 0, preview_cards: [], has_more: false }];
  assert.deepEqual(parseClutchpacksPackMembershipV1(empty)?.membership.items, []);
  assert.equal(parseClutchpacksPackMembershipV1(empty)?.membership.completeness, "complete");
  for (const count of [-1, 0.5, Number.NaN, 1001]) {
    assert.throws(() => parseClutchpacksPackMembershipV1({ ...empty, price_bucket_odds: [
      { ...empty.price_bucket_odds[0], drawable_count: count },
    ] }), /invalid_evidence/u);
  }
  const bad = source();
  bad.price_bucket_odds[0]!.drawable_count = 0;
  assert.throws(() => parseClutchpacksPackMembershipV1(bad), /invalid_evidence/u);
  bad.price_bucket_odds[0]!.drawable_count = 1;
  bad.price_bucket_odds[0]!.has_more = true;
  assert.throws(() => parseClutchpacksPackMembershipV1(bad), /invalid_evidence/u);
});

test("duplicate bucket and card identities are refused instead of silently merged", () => {
  const duplicateBucket = source();
  duplicateBucket.price_bucket_odds[1]!.bucket_id = duplicateBucket.price_bucket_odds[0]!.bucket_id;
  assert.throws(() => parseClutchpacksPackMembershipV1(duplicateBucket), /invalid_evidence/u);
  const duplicateCard = source();
  duplicateCard.price_bucket_odds[1]!.preview_cards[0] = card(100);
  assert.throws(() => parseClutchpacksPackMembershipV1(duplicateCard), /invalid_evidence/u);
});

test("invalid identities, titles and image origins are rejected at the native boundary", () => {
  for (const override of [{ id: "not-a-native-id" }, { title: " " }, { title: "x".repeat(1001) },
    { front_image_url: "not a URL" },
    { front_image_url: "https://unapproved.example/card.jpg" },
    { front_image_url: "http://d18ez2bunk7yz0.cloudfront.net/cards/card.jpg" },
    { front_image_url: "https://token@d18ez2bunk7yz0.cloudfront.net/cards/card.jpg" }]) {
    const data = source();
    data.price_bucket_odds[0]!.preview_cards[0] = { ...card(100), ...override };
    assert.throws(() => parseClutchpacksPackMembershipV1(data), /invalid_evidence/u);
  }
  assert.throws(() => parseClutchpacksPackMembershipV1({ ...source(), price_bucket_odds: "wrong" }), /invalid_evidence/u);
});

test("1000 preview cards fit the contract and card/bucket overflow fails", () => {
  const data = { ...source(), price_bucket_odds: [{ bucket_id: id(10), drawable_count: 1000,
    preview_cards: Array.from({ length: 1000 }, (_, index) => card(10_000 + index)), has_more: false }] };
  assert.equal(parseClutchpacksPackMembershipV1(data)?.membership.items.length, 1000);
  data.price_bucket_odds.push({ bucket_id: id(11), drawable_count: 1, preview_cards: [card(20_000)], has_more: false });
  assert.throws(() => parseClutchpacksPackMembershipV1(data), /invalid_evidence/u);
  const tooManyBuckets = { ...source(), price_bucket_odds: Array.from({ length: 65 }, (_, index) =>
    ({ bucket_id: id(10_000 + index), drawable_count: 0, preview_cards: [], has_more: false })) };
  assert.throws(() => parseClutchpacksPackMembershipV1(tooManyBuckets), /invalid_evidence/u);
});
