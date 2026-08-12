import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOperatorRequestSchema,
  loginRequestSchema,
  updateOperatorRequestSchema,
} from "./auth.ts";

test("login normalizes email without changing credential bytes", () => {
  const parsed = loginRequestSchema.parse({
    email: "  ADMIN@PackScout.Test ",
    password: " Case Sensitive Password ",
  });
  assert.deepEqual(parsed, {
    email: "admin@packscout.test",
    password: " Case Sensitive Password ",
  });
});

test("operator mutations reject weak credentials and unknown executable fields", () => {
  assert.equal(
    createOperatorRequestSchema.safeParse({
      email: "operator@packscout.test",
      displayName: "Operator",
      password: "short",
      role: "data_operator",
    }).success,
    false,
  );
  assert.equal(
    updateOperatorRequestSchema.safeParse({
      role: "admin",
      command: "grant-all",
    }).success,
    false,
  );
  assert.equal(updateOperatorRequestSchema.safeParse({}).success, false);
});
