import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { PrismaProviderCommandRepository } from
  "./provider-command-repository.ts";

test("an import worker selects only accepted run commands", async () => {
  let received: unknown;
  const database = {
    control_commands: {
      findFirst(input: unknown) {
        received = input;
        return Promise.resolve(null);
      },
    },
  } as unknown as ProviderPrismaClient;

  const command = await new PrismaProviderCommandRepository(database)
    .nextAccepted({ commandTypes: ["run"] });

  assert.equal(command, null);
  assert.deepEqual(received, {
    where: { state: "accepted", command_type: { in: ["run"] } },
    orderBy: [{ requested_at: "asc" }, { id: "asc" }],
  });
});

test("an empty accepted-command capability filter fails before querying", async () => {
  let queried = false;
  const database = {
    control_commands: {
      findFirst() {
        queried = true;
        return Promise.resolve(null);
      },
    },
  } as unknown as ProviderPrismaClient;

  await assert.rejects(
    new PrismaProviderCommandRepository(database).nextAccepted({
      commandTypes: [],
    }),
    /At least one accepted command type is required/u,
  );
  assert.equal(queried, false);
});
