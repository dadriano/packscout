import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmailDeliveryAdapter } from "./adapter.ts";
import {
  EmailDeliveryAdapterRegistry,
  EmailDeliveryRegistryError,
} from "./registry.ts";
import { createStubEmailDeliveryAdapter } from "./stub-adapter.test-support.ts";

function registryError(code: EmailDeliveryRegistryError["code"]) {
  return (error: unknown) =>
    error instanceof EmailDeliveryRegistryError && error.code === code;
}

test("registering an adapter is the only step needed to make it selectable", () => {
  const registry = new EmailDeliveryAdapterRegistry();
  assert.equal(registry.defaultAdapter(), null);
  assert.equal(registry.has("email-stub"), false);

  const first = createStubEmailDeliveryAdapter();
  registry.register(first);
  assert.equal(registry.has("email-stub"), true);
  assert.equal(registry.resolve("email-stub"), first);
  assert.equal(registry.defaultAdapter(), first);

  const second = createStubEmailDeliveryAdapter("email-stub-secondary");
  registry.register(second);
  assert.equal(registry.resolve("email-stub-secondary"), second);
  assert.equal(
    registry.defaultAdapter(),
    first,
    "a later adapter never displaces the single default",
  );
  assert.deepEqual(registry.names(), ["email-stub", "email-stub-secondary"]);
});

test("duplicate, unknown, reserved, and invalid adapter names fail closed", () => {
  const registry = new EmailDeliveryAdapterRegistry([
    createStubEmailDeliveryAdapter(),
  ]);
  assert.throws(
    () => registry.register(createStubEmailDeliveryAdapter()),
    registryError("duplicate_adapter_name"),
  );
  assert.throws(
    () => registry.resolve("missing-adapter"),
    registryError("unknown_adapter_name"),
  );
  for (const reserved of ["auto", "disabled", "console"]) {
    assert.throws(
      () => registry.register(createStubEmailDeliveryAdapter(reserved)),
      registryError("reserved_adapter_name"),
    );
  }
  for (const invalid of ["../adapter", "Email-Stub", "", "a".repeat(65)]) {
    assert.equal(registry.has(invalid), false);
    assert.throws(
      () => registry.resolve(invalid),
      registryError("invalid_adapter_name"),
    );
    assert.throws(
      () => registry.register(createStubEmailDeliveryAdapter(invalid)),
      registryError("invalid_adapter_name"),
    );
  }
  assert.deepEqual(registry.names(), ["email-stub"]);
});

test("adapters without the required capabilities are refused", () => {
  const registry = new EmailDeliveryAdapterRegistry();
  const conforming = createStubEmailDeliveryAdapter();
  const broken: readonly unknown[] = [
    { ...conforming, isConfigured: undefined },
    { ...conforming, send: "not-a-function" },
    { ...conforming, missingConfiguration: undefined },
    {
      ...conforming,
      missingConfiguration: { errorCode: "lower_case", message: "m" },
    },
    {
      ...conforming,
      missingConfiguration: { errorCode: "EMAIL_STUB_UNCONFIGURED", message: "   " },
    },
    {
      ...conforming,
      missingConfiguration: {
        errorCode: "EMAIL_STUB_UNCONFIGURED",
        message: "m".repeat(201),
      },
    },
  ];
  for (const adapter of broken) {
    assert.throws(
      () => registry.register(adapter as EmailDeliveryAdapter),
      registryError("invalid_adapter_capability"),
    );
  }
  assert.deepEqual(registry.names(), []);
});
