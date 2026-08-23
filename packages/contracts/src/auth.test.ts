import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOperatorRequestSchema,
  loginRequestSchema,
  passwordResetCompletionRequestSchema,
  passwordResetRequestSchema,
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

test("password reset request normalizes email exactly like sign-in", () => {
  const parsed = passwordResetRequestSchema.parse({
    email: "  Operator@PackScout.Test ",
  });
  assert.deepEqual(parsed, { email: "operator@packscout.test" });
  assert.equal(
    passwordResetRequestSchema.safeParse({ email: "not-an-address" }).success,
    false,
  );
  assert.equal(
    passwordResetRequestSchema.safeParse({ email: "a@b.test", extra: true })
      .success,
    false,
  );
});

test("password reset completion reuses the managed password rules verbatim", () => {
  const token = `${"a".repeat(22)}.${"b".repeat(43)}`;
  assert.equal(
    passwordResetCompletionRequestSchema.safeParse({
      token,
      password: "a strong enough password",
    }).success,
    true,
  );

  // The same bounds and messages an administrator-set password must satisfy.
  const short = passwordResetCompletionRequestSchema.safeParse({
    token,
    password: "short",
  });
  assert.equal(short.success, false);
  const shortMessage = short.success
    ? []
    : short.error.flatten().fieldErrors.password;
  assert.deepEqual(shortMessage, ["Password must be at least 12 characters."]);
  const adminSide = createOperatorRequestSchema.safeParse({
    email: "operator@packscout.test",
    displayName: "Operator",
    password: "short",
    role: "data_operator",
  });
  const adminMessage = adminSide.success
    ? []
    : adminSide.error.flatten().fieldErrors.password;
  assert.deepEqual(shortMessage, adminMessage);

  assert.equal(
    passwordResetCompletionRequestSchema.safeParse({
      token: "",
      password: "a strong enough password",
    }).success,
    false,
  );
  assert.equal(
    passwordResetCompletionRequestSchema.safeParse({
      token,
      password: "a strong enough password",
      extra: true,
    }).success,
    false,
  );
});
