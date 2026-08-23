import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOperatorRequestSchema,
  loginRequestSchema,
  operatorPermissions,
  operatorRolePermissions,
  permissionsForOperatorRole,
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

test("product-user administration is granted to administrators only", () => {
  assert.ok(operatorPermissions.includes("product_users:view"));
  assert.ok(operatorPermissions.includes("product_users:manage"));

  const administrator = permissionsForOperatorRole("admin");
  assert.ok(administrator.includes("product_users:view"));
  assert.ok(administrator.includes("product_users:manage"));

  const dataOperator = permissionsForOperatorRole("data_operator");
  assert.equal(dataOperator.includes("product_users:view"), false);
  assert.equal(dataOperator.includes("product_users:manage"), false);
  // The data operator's existing capability set is unchanged by this feature.
  assert.deepEqual(dataOperator, [
    "providers:view",
    "imports:start",
    "imports:retry",
  ]);
});

test("role grants stay inside the shared permission vocabulary", () => {
  const vocabulary = new Set<string>(operatorPermissions);
  for (const [role, granted] of Object.entries(operatorRolePermissions)) {
    assert.equal(
      new Set(granted).size,
      granted.length,
      `${role} grants a duplicate permission.`,
    );
    for (const permission of granted) {
      assert.ok(vocabulary.has(permission), `${role} grants ${permission}.`);
    }
  }
  // Administrators remain a superset of every data-operator capability.
  for (const permission of operatorRolePermissions.data_operator) {
    assert.ok(operatorRolePermissions.admin.includes(permission));
  }
  // A returned grant is a copy, so callers cannot mutate the shared vocabulary.
  permissionsForOperatorRole("admin").length = 0;
  assert.ok(permissionsForOperatorRole("admin").includes("product_users:view"));
});

test("beta-allowlist administration is granted to administrators only", () => {
  assert.ok(operatorPermissions.includes("beta_allowlist:view"));
  assert.ok(operatorPermissions.includes("beta_allowlist:manage"));

  const administrator = permissionsForOperatorRole("admin");
  assert.ok(administrator.includes("beta_allowlist:view"));
  assert.ok(administrator.includes("beta_allowlist:manage"));

  const dataOperator = permissionsForOperatorRole("data_operator");
  assert.equal(dataOperator.includes("beta_allowlist:view"), false);
  assert.equal(dataOperator.includes("beta_allowlist:manage"), false);
  // The data operator's existing capability set is unchanged by this feature.
  assert.deepEqual(dataOperator, [
    "providers:view",
    "imports:start",
    "imports:retry",
  ]);
});

test("message-delivery inspection is granted to administrators only", () => {
  assert.ok(operatorPermissions.includes("message_delivery:view"));
  assert.ok(operatorPermissions.includes("message_delivery:manage"));

  const administrator = permissionsForOperatorRole("admin");
  assert.ok(administrator.includes("message_delivery:view"));
  assert.ok(administrator.includes("message_delivery:manage"));

  const dataOperator = permissionsForOperatorRole("data_operator");
  assert.equal(dataOperator.includes("message_delivery:view"), false);
  assert.equal(dataOperator.includes("message_delivery:manage"), false);
  // The data operator's existing capability set is unchanged by this feature.
  assert.deepEqual(dataOperator, [
    "providers:view",
    "imports:start",
    "imports:retry",
  ]);
});
