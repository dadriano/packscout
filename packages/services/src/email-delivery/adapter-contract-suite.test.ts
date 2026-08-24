import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emailDeliveryAdapterContractChecks,
  runEmailDeliveryAdapterContractSuite,
  type EmailDeliveryAdapterContractOptions,
} from "./adapter-contract-suite.test-support.ts";
import {
  createBrokenStubEmailDeliveryAdapter,
  createStubEmailDeliveryAdapter,
  stubAdapterContractScenarios,
  stubConfiguredEnv,
  stubUnconfiguredEnv,
  type StubEmailAdapterDefect,
} from "./stub-adapter.test-support.ts";

function contractOptions(
  adapter: EmailDeliveryAdapterContractOptions["adapter"],
): EmailDeliveryAdapterContractOptions {
  return {
    adapter,
    environments: {
      configured: stubConfiguredEnv(),
      unconfigured: stubUnconfiguredEnv(),
    },
    scenarios: stubAdapterContractScenarios(),
  };
}

// A conforming adapter passes the published contract: this registers the full
// behavior matrix as real tests against the stub adapter.
runEmailDeliveryAdapterContractSuite(
  contractOptions(createStubEmailDeliveryAdapter()),
);

const violations: readonly (readonly [StubEmailAdapterDefect, string])[] = [
  [
    "throws_on_send",
    "safety: send resolves to a structured result in every scenario",
  ],
  [
    "misclassifies_rejected_recipient",
    "classification: a rejected recipient is a non-retryable failure",
  ],
  [
    "leaks_provider_error_text",
    "sanitation: provider error text is sanitized and length-bounded",
  ],
  [
    "reports_configured_when_missing",
    "configuration: reports configured and unconfigured environments without throwing",
  ],
  [
    "hangs_without_transport",
    "timeout: an unresponsive transport yields a bounded retryable failure",
  ],
  [
    "invents_success_shape",
    "success: a delivered send reports sent with the provider message identifier",
  ],
];

for (const [defect, violatedCheck] of violations) {
  test(`the contract suite rejects an adapter that ${defect.replaceAll("_", " ")}`, async () => {
    const checks = emailDeliveryAdapterContractChecks(
      contractOptions(createBrokenStubEmailDeliveryAdapter(defect)),
    );
    const check = checks.find(({ name }) => name === violatedCheck);
    assert.ok(check, `contract check "${violatedCheck}" must exist`);
    await assert.rejects(check.run());
  });
}

test("the published contract matrix keeps its full breadth", () => {
  const names = emailDeliveryAdapterContractChecks(
    contractOptions(createStubEmailDeliveryAdapter()),
  ).map(({ name }) => name);
  assert.equal(names.length, 12);
  assert.equal(new Set(names).size, names.length, "check names are unique");
  for (const area of [
    "identity:",
    "configuration:",
    "success:",
    "classification:",
    "sanitation:",
    "timeout:",
    "safety:",
  ]) {
    assert.ok(
      names.some((name) => name.startsWith(area)),
      `the matrix covers ${area}`,
    );
  }
});
