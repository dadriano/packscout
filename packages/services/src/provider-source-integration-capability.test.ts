import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderMappingAdapterRegistry,
  ProviderTransportAdapterRegistry,
} from "./provider-adapter-registry.ts";
import { ProviderSourceIntegrationCapabilityRegistry } from
  "./provider-source-integration-capability.ts";

test("only explicitly installed source integrations advertise execution capability", () => {
  const installed = new ProviderSourceIntegrationCapabilityRegistry([
    { adapterKey: "source_alpha", sourceNeutralPageExecution: true },
    { adapterKey: "source_beta", sourceNeutralPageExecution: true },
  ]);

  assert.deepEqual(installed.keys(), ["source_alpha", "source_beta"]);
  assert.equal(installed.has("source_alpha"), true);
  assert.equal(installed.has("source_beta"), true);
  assert.equal(installed.has("configured_but_not_installed"), false);

  const mappings = new ProviderMappingAdapterRegistry();
  const transports = new ProviderTransportAdapterRegistry();
  assert.deepEqual(mappings.keys(), []);
  assert.deepEqual(transports.keys(), []);
  assert.equal(installed.has("legacy_mapping_or_transport"), false);
});

test("invalid or duplicate source capability declarations fail closed", () => {
  assert.throws(
    () => new ProviderSourceIntegrationCapabilityRegistry([
      { adapterKey: "source_alpha", sourceNeutralPageExecution: true },
      { adapterKey: "source_alpha", sourceNeutralPageExecution: true },
    ]),
    /duplicated/,
  );
  assert.throws(
    () => new ProviderSourceIntegrationCapabilityRegistry([
      { adapterKey: "INVALID KEY", sourceNeutralPageExecution: true },
    ]),
    /invalid/,
  );
});
