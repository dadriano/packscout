import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepFrozenJsonValue } from "./source-adapter-contract-primitives.ts";
import {
  isTrustedProtectedNativeEvidence,
  sealTrustedProtectedNativeEvidence,
} from "./trusted-protected-native-evidence.ts";

test("trusted native evidence validates plain JSON and deep-freezes every object", () => {
  const evidence = [{
    reference: "page_record:0",
    value: {
      nested: [{ retained: "complete" }],
      nullable: null,
      finite: 12.5,
    },
  }];
  const sealed = sealTrustedProtectedNativeEvidence(evidence);
  assert.strictEqual(sealed, evidence);
  assert.equal(isTrustedProtectedNativeEvidence(sealed), true);
  assert.equal(isDeepFrozenJsonValue(sealed), true);
  assert.throws(() => {
    (evidence[0]!.value.nested[0] as { retained: string }).retained =
      "mutated";
  }, TypeError);
});

test("trusted native evidence rejects accessors, non-plain objects, cycles, and brand lookalikes", () => {
  const accessorValue: Record<string, unknown> = {};
  Object.defineProperty(accessorValue, "secret", {
    enumerable: true,
    get: () => "not-data",
  });
  const cyclicValue: Record<string, unknown> = {};
  cyclicValue.self = cyclicValue;
  class NonPlainEvidence {
    retained = true;
  }
  for (const value of [
    accessorValue,
    cyclicValue,
    new NonPlainEvidence(),
  ]) {
    assert.throws(
      () => sealTrustedProtectedNativeEvidence([{
        reference: "page_record:0",
        value: value as unknown as Readonly<Record<string, unknown>>,
      }]),
      TypeError,
    );
  }

  const accessorArray: unknown[] = ["retained"];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get: () => "not-data",
  });
  assert.throws(
    () => sealTrustedProtectedNativeEvidence([{
      reference: "page_record:0",
      value: { accessorArray },
    }]),
    TypeError,
  );

  const lookalike = Object.freeze([Object.freeze({
    reference: "page_record:0",
    value: Object.freeze({ retained: "complete" }),
  })]);
  assert.equal(isDeepFrozenJsonValue(lookalike), true);
  assert.equal(isTrustedProtectedNativeEvidence(lookalike), false);
});
