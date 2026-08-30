import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { PrismaProviderActivityOutboxRepository } from
  "./provider-activity-outbox-repository.ts";

test("a mark-delivered CAS loser observes the concurrent delivery", async () => {
  let reads = 0;
  const database = {
    provider_activity_outbox: {
      findUnique() {
        reads += 1;
        return Promise.resolve({
          event_digest: "a".repeat(64),
          delivery_state: reads === 1 ? "pending" : "delivered",
        });
      },
      updateMany() {
        return Promise.resolve({ count: 0 });
      },
    },
  } as unknown as ProviderPrismaClient;

  assert.equal(
    await new PrismaProviderActivityOutboxRepository(database).markDelivered({
      eventId: "72000000-0000-4000-8000-000000000001",
      eventDigest: "a".repeat(64),
      deliveredAt: new Date("2026-08-29T12:00:00.000Z"),
    }),
    "already_delivered",
  );
  assert.equal(reads, 2);
});
