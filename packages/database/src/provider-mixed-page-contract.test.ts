import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { CanonicalJsonObject } from "./provider-canonical-contract.ts";
import {
  PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
  PROVIDER_MIXED_PAGE_MAX_RECORDS,
  ProviderMixedPageContractError,
  providerMixedCursorFingerprint,
  providerMixedPageDigest,
  validateProviderMixedPage,
} from "./provider-mixed-page-contract.ts";

function mixedPage(input: {
  readonly providerId?: string;
  readonly records?: readonly Record<string, unknown>[];
  readonly inputCursor?: CanonicalJsonObject | null;
  readonly nextCursor?: CanonicalJsonObject | null;
  readonly continuation?: "more" | "head";
  readonly overrides?: Readonly<Record<string, unknown>>;
} = {}): Record<string, unknown> {
  const providerId = input.providerId ?? randomUUID();
  const inputCursor = input.inputCursor ?? null;
  const nextCursor = input.nextCursor === undefined ? { after: "page-1" } : input.nextCursor;
  const continuation = input.continuation ?? "more";
  const body = {
    contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
    providerId,
    runId: randomUUID(),
    configVersionId: randomUUID(),
    configVersionNumber: "1",
    leaseFence: "1",
    pageId: randomUUID(),
    pageNumber: 1,
    inputCursor,
    inputCursorFingerprint: providerMixedCursorFingerprint(inputCursor),
    nextCursor,
    nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor),
    continuation,
    records: input.records ?? [{
      position: 0,
      providerId,
      kind: "catalog",
      operation: "upsert",
      entityType: "category",
      candidate: {
        categoryKey: "sports",
        parentCategoryKey: null,
        displayName: "Sports",
        expectedRowVersion: null,
      },
    }],
    ...input.overrides,
  };
  return { ...body, responseDigest: providerMixedPageDigest(body) };
}

function assertContractCode(code: string, callback: () => unknown): void {
  assert.throws(callback, (error: unknown) => (
    error instanceof ProviderMixedPageContractError && error.code === code
  ));
}

function providerAccountPage(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const providerId = randomUUID();
  return mixedPage({
    providerId,
    records: [{
      position: 0,
      providerId,
      kind: "catalog",
      operation: "upsert",
      entityType: "provider_account",
      candidate: {
        accountKey: "d".repeat(64),
        displayName: null,
        attributes,
        expectedRowVersion: null,
      },
    }],
  });
}

test("mixed page validator accepts one source-neutral ordered page", () => {
  const page = mixedPage();
  const validated = validateProviderMixedPage(page);
  assert.equal(validated.records.length, 1);
  assert.equal(validated.records[0]?.kind, "catalog");
  assert.equal(validated.configVersionNumber, 1n);
  assert.equal(validated.leaseFence, 1n);
});

test("mixed page validator rejects unknown fields at every contracted level", () => {
  const top = mixedPage({ overrides: { credential: "must-not-pass" } });
  assertContractCode("MIXED_PAGE_UNKNOWN_FIELD", () => validateProviderMixedPage(top));

  const providerId = randomUUID();
  const record = mixedPage({
    providerId,
    records: [{
      position: 0,
      providerId,
      kind: "pull",
      candidate: {
        pullKey: "pull-1", factDigest: "0".repeat(64), packKey: "pack-1",
        providerAccountKey: null, occurredAt: "2026-08-29T00:00:00.000Z",
        paidAmount: null, paidCurrency: null,
        items: [{
          collectibleKey: "card-1", collectibleInstanceKey: null, quantity: "1",
          statedValueAmount: null, statedValueCurrency: null, rawPayload: "no",
        }],
      },
    }],
  });
  assertContractCode("MIXED_PAGE_UNKNOWN_FIELD", () => validateProviderMixedPage(record));

  for (const key of [
    "token", "accessToken", "refresh_token", "api-key", "clientSecret",
    "private_key", "connectionString", "dsn", "credentials", "raw_response",
  ]) {
    assertContractCode(
      "MIXED_PAGE_INVALID",
      () => validateProviderMixedPage(providerAccountPage({ nested: { [key]: "must-not-persist" } })),
    );
  }

  const publicTokenMetadata = validateProviderMixedPage(providerAccountPage({
    tokenAddress: "0x0000000000000000000000000000000000000000",
  }));
  assert.equal(
    (publicTokenMetadata.records[0]?.candidate.attributes as Record<string, unknown>).tokenAddress,
    "0x0000000000000000000000000000000000000000",
  );
});

test("mixed page validator rejects non-plain JSON and returns a detached canonical candidate", () => {
  assertContractCode(
    "MIXED_PAGE_INVALID",
    () => providerMixedPageDigest({ observedAt: new Date("2026-08-29T00:00:00.000Z") }),
  );

  const dateAttributes: Record<string, unknown> = {};
  const datePage = providerAccountPage(dateAttributes);
  dateAttributes.observedAt = new Date("2026-08-29T00:00:00.000Z");
  assertContractCode("MIXED_PAGE_INVALID", () => validateProviderMixedPage(datePage));

  const customAttributes: Record<string, unknown> = {};
  const customPage = providerAccountPage(customAttributes);
  customAttributes.nested = Object.create({ inherited: "not-json" }) as object;
  assertContractCode("MIXED_PAGE_INVALID", () => validateProviderMixedPage(customPage));

  const inputAttributes = {
    zulu: { beta: 2, alpha: 1 },
    alpha: "first",
  };
  const validated = validateProviderMixedPage(providerAccountPage(inputAttributes));
  const candidate = validated.records[0]?.candidate;
  const attributes = candidate?.attributes as Record<string, unknown>;
  assert.notEqual(candidate, inputAttributes);
  assert.notEqual(attributes, inputAttributes);
  assert.equal(Object.getPrototypeOf(attributes), Object.prototype);
  assert.deepEqual(Object.keys(attributes), ["alpha", "zulu"]);
  assert.deepEqual(Object.keys(attributes.zulu as object), ["alpha", "beta"]);
});

test("mixed page validator rejects provider, position, cursor, head, and digest violations", () => {
  const providerId = randomUUID();
  const wrongProvider = mixedPage({
    providerId,
    records: [{
      position: 0, providerId: randomUUID(), kind: "market_event",
      candidate: {},
    }],
  });
  assertContractCode("MIXED_PAGE_PROVIDER_MISMATCH", () => validateProviderMixedPage(wrongProvider));

  const duplicatePosition = mixedPage({
    providerId,
    records: [0, 0].map((position) => ({
      position, providerId, kind: "catalog", operation: "upsert", entityType: "category",
      candidate: {},
    })),
  });
  assertContractCode("MIXED_PAGE_DUPLICATE_POSITION", () => validateProviderMixedPage(duplicatePosition));

  const cursor = mixedPage({ overrides: { nextCursorFingerprint: "f".repeat(64) } });
  assertContractCode("MIXED_PAGE_CURSOR_MISMATCH", () => validateProviderMixedPage(cursor));

  const head = mixedPage({ continuation: "head" });
  assertContractCode("MIXED_PAGE_CURSOR_MISMATCH", () => validateProviderMixedPage(head));

  const digest = { ...mixedPage(), responseDigest: "a".repeat(64) };
  assertContractCode("MIXED_PAGE_DIGEST_MISMATCH", () => validateProviderMixedPage(digest));

  const version = mixedPage({ overrides: { contractVersion: "mixed-page-v0" } });
  assertContractCode("MIXED_PAGE_INVALID", () => validateProviderMixedPage(version));
});

test("mixed page validator enforces bounded records and canonical cursor bytes", () => {
  const providerId = randomUUID();
  const records = Array.from({ length: PROVIDER_MIXED_PAGE_MAX_RECORDS + 1 }, (_, position) => ({
    position, providerId, kind: "catalog", operation: "upsert", entityType: "category",
    candidate: {},
  }));
  assertContractCode(
    "MIXED_PAGE_OVERSIZED",
    () => validateProviderMixedPage(mixedPage({ providerId, records })),
  );
  const largeCursor = { value: "x".repeat(17_000) };
  assertContractCode(
    "MIXED_PAGE_OVERSIZED",
    () => validateProviderMixedPage(mixedPage({ nextCursor: largeCursor })),
  );
  assertContractCode(
    "MIXED_PAGE_INVALID",
    () => validateProviderMixedPage(mixedPage({
      overrides: { configVersionNumber: "9223372036854775808" },
    })),
  );
});

test("mixed page cursor fingerprints are property-stable across object key order", () => {
  for (let value = 0; value < 100; value += 1) {
    const left = { value, nested: { beta: value + 1, alpha: value - 1 } };
    const right = { nested: { alpha: value - 1, beta: value + 1 }, value };
    assert.equal(providerMixedCursorFingerprint(left), providerMixedCursorFingerprint(right));
  }
});
