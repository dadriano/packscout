import assert from "node:assert/strict";
import test from "node:test";
import {
  PromotionJobMonitoringIdCodec,
  PromotionJobMonitoringNotFoundError,
  promotionJobMonitoringOrderKey,
} from "./promotion-job-monitoring-id.ts";

const codec = new PromotionJobMonitoringIdCodec(new Uint8Array(32).fill(4));
const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  deployment: "production",
};
const centralId = "20000000-0000-4000-8000-000000000002";

test("opaque monitoring IDs are stable and round-trip only central identity", () => {
  const first = codec.encode(scope, { kind: "provider", centralId });
  const second = codec.encode(scope, { kind: "provider", centralId });
  assert.equal(first, second);
  assert.match(first, /^pj_[A-Za-z0-9_-]{24,160}$/u);
  assert.ok(first.startsWith(`pj_${promotionJobMonitoringOrderKey({
    kind: "provider",
    centralId,
  })}_`));
  assert.equal(first.includes(centralId), false);
  assert.deepEqual(codec.decode(scope, first), {
    kind: "provider",
    centralId,
  });
});

test("the opaque prefix is a stable global tie-breaker without exposing identity", () => {
  const provider = promotionJobMonitoringOrderKey({
    kind: "provider",
    centralId,
  });
  const manifest = promotionJobMonitoringOrderKey({
    kind: "manifest",
    centralId,
  });
  assert.match(provider, /^[0-9a-f]{64}$/u);
  assert.notEqual(provider, manifest);
  assert.equal(provider.includes(centralId.replaceAll("-", "")), false);
});

test("opaque monitoring IDs bind kind, organization, deployment, and integrity", () => {
  const monitoringId = codec.encode(scope, { kind: "manifest", centralId });
  const tamperAt = 20;
  const tampered = `${monitoringId.slice(0, tamperAt)}${
    monitoringId[tamperAt] === "A" ? "B" : "A"
  }${monitoringId.slice(tamperAt + 1)}`;
  assert.deepEqual(codec.decode(scope, monitoringId).kind, "manifest");
  for (const [candidateScope, candidateId] of [
    [{ ...scope, organizationId: "10000000-0000-4000-8000-000000000009" }, monitoringId],
    [{ ...scope, deployment: "preproduction" }, monitoringId],
    [scope, tampered],
  ] as const) {
    assert.throws(
      () => codec.decode(candidateScope, candidateId),
      PromotionJobMonitoringNotFoundError,
    );
  }
});
