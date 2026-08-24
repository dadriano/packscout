import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inviteOperatorRequestSchema,
  loginRequestSchema,
  operatorAssignableStates,
  operatorInvitationAcceptanceRequestSchema,
  operatorStates,
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
  // Creating an operator is an invitation: an address, a name, and a role.
  // A password is not optional here, it is refused, so new accounts cannot
  // quietly go back to an administrator-chosen credential.
  assert.equal(
    inviteOperatorRequestSchema.safeParse({
      email: "operator@packscout.test",
      displayName: "Operator",
      role: "data_operator",
    }).success,
    true,
  );
  assert.equal(
    inviteOperatorRequestSchema.safeParse({
      email: "operator@packscout.test",
      displayName: "Operator",
      password: "an administrator chosen password",
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
  // The data operator's pipeline capabilities are unchanged by this feature.
  assert.deepEqual(dataOperator, [
    "providers:view",
    "imports:start",
    "imports:retry",
    "data_inspection:view",
  ]);
});

/**
 * Asserted against the authoritative grant table rather than an injected
 * permission set. A session's permissions are built from this table, so a
 * permission present in the vocabulary but absent from every role is invisible
 * to every real operator — which is exactly the defect this test exists to
 * catch.
 */
test("data inspection is granted to both operator roles", () => {
  assert.ok(operatorPermissions.includes("data_inspection:view"));
  for (const role of ["admin", "data_operator"] as const) {
    assert.ok(
      permissionsForOperatorRole(role).includes("data_inspection:view"),
      `${role} should hold data_inspection:view`,
    );
  }
});

/**
 * Every permission in the vocabulary reaches at least one role. A permission
 * granted to nobody gates a surface nobody can open, and the failure is silent:
 * routes refuse and navigation hides, with nothing to show the cause.
 */
test("no permission exists in the vocabulary without a role that grants it", () => {
  const granted = new Set<string>(
    Object.values(operatorRolePermissions).flatMap((list) => [...list]),
  );
  for (const permission of operatorPermissions) {
    assert.ok(granted.has(permission), `${permission} is granted to no role.`);
  }
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
  // The data operator's pipeline capabilities are unchanged by this feature.
  assert.deepEqual(dataOperator, [
    "providers:view",
    "imports:start",
    "imports:retry",
    "data_inspection:view",
  ]);
});

/**
 * Asserted against the authoritative grant table rather than an injected
 * permission set. A session's permissions are built from this table, so a
 * permission present in the vocabulary but absent from every role is invisible
 * to every real operator — which is exactly the defect this test exists to
 * catch.
 */
test("data inspection is granted to both operator roles", () => {
  assert.ok(operatorPermissions.includes("data_inspection:view"));
  for (const role of ["admin", "data_operator"] as const) {
    assert.ok(
      permissionsForOperatorRole(role).includes("data_inspection:view"),
      `${role} should hold data_inspection:view`,
    );
  }
});

/**
 * Every permission in the vocabulary reaches at least one role. A permission
 * granted to nobody gates a surface nobody can open, and the failure is silent:
 * routes refuse and navigation hides, with nothing to show the cause.
 */
test("no permission exists in the vocabulary without a role that grants it", () => {
  const granted = new Set<string>(
    Object.values(operatorRolePermissions).flatMap((list) => [...list]),
  );
  for (const permission of operatorPermissions) {
    assert.ok(granted.has(permission), `${permission} is granted to no role.`);
  }
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
  // The data operator's pipeline capabilities are unchanged by this feature.
  assert.deepEqual(dataOperator, [
    "providers:view",
    "imports:start",
    "imports:retry",
    "data_inspection:view",
  ]);
});

/**
 * Asserted against the authoritative grant table rather than an injected
 * permission set. A session's permissions are built from this table, so a
 * permission present in the vocabulary but absent from every role is invisible
 * to every real operator — which is exactly the defect this test exists to
 * catch.
 */
test("data inspection is granted to both operator roles", () => {
  assert.ok(operatorPermissions.includes("data_inspection:view"));
  for (const role of ["admin", "data_operator"] as const) {
    assert.ok(
      permissionsForOperatorRole(role).includes("data_inspection:view"),
      `${role} should hold data_inspection:view`,
    );
  }
});

/**
 * Every permission in the vocabulary reaches at least one role. A permission
 * granted to nobody gates a surface nobody can open, and the failure is silent:
 * routes refuse and navigation hides, with nothing to show the cause.
 */
test("no permission exists in the vocabulary without a role that grants it", () => {
  const granted = new Set<string>(
    Object.values(operatorRolePermissions).flatMap((list) => [...list]),
  );
  for (const permission of operatorPermissions) {
    assert.ok(granted.has(permission), `${permission} is granted to no role.`);
  }
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
  const adminSide = updateOperatorRequestSchema.safeParse({
    password: "short",
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

test("the operator state vocabulary carries invitation lifecycle without widening what an update may assign", () => {
  // Pending and cancelled exist so the ledger can tell an invited account
  // and a withdrawn one apart from the enabled and disabled states that
  // already existed.
  assert.deepEqual(
    [...operatorStates],
    ["pending", "active", "disabled", "cancelled"],
  );
  // But neither is reachable through an ordinary update: `pending` comes only
  // from inviting and `cancelled` only from cancelling.
  assert.deepEqual([...operatorAssignableStates], ["active", "disabled"]);
  for (const state of ["pending", "cancelled"]) {
    assert.equal(
      updateOperatorRequestSchema.safeParse({ state }).success,
      false,
      `${state} must not be directly assignable`,
    );
  }
  assert.equal(
    updateOperatorRequestSchema.safeParse({ state: "disabled" }).success,
    true,
  );
});

test("invitation acceptance reuses the admin's password rules and refuses extra fields", () => {
  const token = `${"a".repeat(22)}.${"b".repeat(43)}`;
  assert.equal(
    operatorInvitationAcceptanceRequestSchema.safeParse({
      token,
      password: "a strong enough password",
    }).success,
    true,
  );
  const short = operatorInvitationAcceptanceRequestSchema.safeParse({
    token,
    password: "short",
  });
  assert.equal(short.success, false);
  assert.deepEqual(
    short.success ? [] : short.error.flatten().fieldErrors.password,
    // The same message an administrator-set password would receive.
    updateOperatorRequestSchema.safeParse({ password: "short" }).success
      ? []
      : updateOperatorRequestSchema
          .safeParse({ password: "short" })
          .error?.flatten().fieldErrors.password,
  );
  assert.equal(
    operatorInvitationAcceptanceRequestSchema.safeParse({
      token: "",
      password: "a strong enough password",
    }).success,
    false,
  );
  assert.equal(
    operatorInvitationAcceptanceRequestSchema.safeParse({
      token,
      password: "a strong enough password",
      role: "admin",
    }).success,
    false,
  );
});
