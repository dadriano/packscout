import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProviderRequestSchema,
  replaceProviderRevisionRequestSchema,
} from "./provider.ts";

test("provider create defaults to five-minute imports and fifteen-minute staleness", () => {
  const parsed = createProviderRequestSchema.parse({
    platformKey: "beezie",
    displayName: "Beezie",
    adapterKey: "http-cursor-v1",
    endpoint: "https://provider.example/feed",
    auth: { mode: "none" },
  });
  assert.equal(parsed.scheduleSeconds, 300);
  assert.equal(parsed.staleAfterSeconds, 900);
});

test("provider create rejects executable identities, invalid timing, and missing bearer secrets", () => {
  for (const value of [
    {
      platformKey: "../beezie",
      displayName: "Beezie",
      adapterKey: "http-cursor-v1",
      endpoint: "https://provider.example/feed",
      auth: { mode: "none" },
    },
    {
      platformKey: "beezie",
      displayName: "Beezie",
      adapterKey: "load()",
      endpoint: "https://provider.example/feed",
      auth: { mode: "none" },
    },
    {
      platformKey: "beezie",
      displayName: "Beezie",
      adapterKey: "http-cursor-v1",
      endpoint: "https://provider.example/feed",
      scheduleSeconds: 0,
      staleAfterSeconds: 0,
      auth: { mode: "none" },
    },
    {
      platformKey: "beezie",
      displayName: "Beezie",
      adapterKey: "http-cursor-v1",
      endpoint: "https://provider.example/feed",
      auth: { mode: "bearer" },
    },
  ]) {
    assert.equal(createProviderRequestSchema.safeParse(value).success, false);
  }
});

test("bearer replacement requires exactly one explicit secret decision", () => {
  const base = {
    expectedRevisionId: "00000000-0000-4000-8000-000000000001",
    adapterKey: "http-cursor-v1",
    endpoint: "https://provider.example/feed",
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
  };
  assert.equal(
    replaceProviderRevisionRequestSchema.safeParse({
      ...base,
      auth: { mode: "bearer" },
    }).success,
    false,
  );
  assert.equal(
    replaceProviderRevisionRequestSchema.safeParse({
      ...base,
      auth: {
        mode: "bearer",
        bearerSecret: "new-secret",
        reuseExistingSecret: true,
      },
    }).success,
    false,
  );
  assert.equal(
    replaceProviderRevisionRequestSchema.safeParse({
      ...base,
      auth: { mode: "bearer", reuseExistingSecret: true },
    }).success,
    true,
  );
});
