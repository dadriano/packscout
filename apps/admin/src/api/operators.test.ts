import assert from "node:assert/strict";
import { test } from "node:test";
import type { DirectProvisionOperatorResponse } from "@packscout/contracts";
import { createOperatorWithPassword } from "./operators.ts";

test("direct operator creation uses its distinct protected API boundary", async () => {
  const input = {
    email: "direct@packscout.test",
    displayName: "Direct Operator",
    password: "an initial secure password",
    role: "data_operator" as const,
  };
  const response: DirectProvisionOperatorResponse = {
    operator: {
      id: "00000000-0000-4000-8000-000000000002",
      email: input.email,
      displayName: input.displayName,
      state: "active",
      role: input.role,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      lastAccessAt: null,
    },
    notification: { status: "enqueued", deduplicated: false },
  };

  const result = await createOperatorWithPassword(input, async (url, init) => {
    assert.equal(url, "/api/operators/direct");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return new Response(JSON.stringify(response), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(result, response);
  assert.doesNotMatch(
    JSON.stringify(result),
    /initial secure password|passwordHash|"password"/i,
  );
});
