import assert from "node:assert/strict";
import test from "node:test";
import { adaptDataforrestCollectorCryptRecordV2 } from
  "./dataforrest-collector-crypt-record-v2.ts";

test("Collector Crypt V2 supplies unknown availability only for catalog packs with no own value", () => {
  const data = Object.freeze({ name: "Collector pack", available: false });
  const record = Object.freeze({
    platform: "collector_crypt",
    stream: "catalog",
    entity: "pack",
    record_id: "collector-pack",
    data,
  });

  const adapted = adaptDataforrestCollectorCryptRecordV2(record);

  assert.deepEqual(adapted, { ...record, available: null });
  assert.notStrictEqual(adapted, record);
  assert.equal(Object.hasOwn(record, "available"), false);
  assert.equal((adapted as { readonly data: unknown }).data, data);
});

test("Collector Crypt V2 preserves explicit availability and malformed present values", () => {
  for (const available of [true, false, null, undefined, "yes", 0, {}]) {
    const record = {
      stream: "catalog",
      entity: "pack",
      available,
      data: { name: "Collector pack" },
    };

    assert.strictEqual(adaptDataforrestCollectorCryptRecordV2(record), record);
    assert.equal(record.available, available);
  }
});

test("Collector Crypt V2 leaves cards, other streams, and non-record inputs untouched", () => {
  const inputs: unknown[] = [
    { stream: "catalog", entity: "card", data: {} },
    { stream: "pulls", entity: "pack", data: {} },
    { stream: "trades", data: {} },
    { stream: "catalog", data: {} },
    null,
    [],
    "catalog",
  ];

  for (const input of inputs) {
    assert.strictEqual(adaptDataforrestCollectorCryptRecordV2(input), input);
  }
});

test("Collector Crypt V2 requires an own outer availability field", () => {
  const prototype = { available: true };
  const record = Object.assign(Object.create(prototype) as Record<string, unknown>, {
    stream: "catalog",
    entity: "pack",
    data: { name: "Collector pack" },
  });

  const adapted = adaptDataforrestCollectorCryptRecordV2(record);

  assert.deepEqual(adapted, {
    stream: "catalog",
    entity: "pack",
    data: { name: "Collector pack" },
    available: null,
  });
  assert.equal(Object.hasOwn(record, "available"), false);
});
