import assert from "node:assert/strict";
import test from "node:test";
import { safeValidateProviderStreamPageV2 } from "@packscout/contracts";
import { ProviderMappingAdapterRegistry } from "./provider-adapter-registry.ts";
import { sourceIdentityForRecord } from "./provider-adapter.ts";
import {
  DefaultProviderImportPagePlanner,
  ProviderImportPlanningError,
} from "./provider-import-page-planner.ts";

const record = {
  stream: "catalog",
  platform: "fixture",
  entity: "pack",
  record_id: "pack-1",
  first_seen_at: "2026-08-13T00:00:00.000Z",
  occurred_at: "2026-08-13T00:00:00.000Z",
  collected_at: "2026-08-13T00:01:00.000Z",
  data: {},
} as const;

test("archive planning rejects a retired stored mapper key instead of switching by platform", async () => {
  const validated = safeValidateProviderStreamPageV2({
    rawPage: { fixture: true },
    normalizedPage: {
      requestedCursor: "archive-v2:0:0",
      nextCursor: "archive-v2:1:0",
      hasMore: false,
      records: [record],
    },
    context: {
      requestedPlatform: "fixture",
      requestedCursor: "archive-v2:0:0",
    },
  });
  assert.equal(validated.success, true);
  if (!validated.success) return;
  const planner = new DefaultProviderImportPagePlanner(
    new ProviderMappingAdapterRegistry([{
      key: "fixture-current-v2",
      platformKey: "fixture",
      mapRecord({ record: mappedRecord, recordIndex }) {
        return {
          status: "mapped",
          source: sourceIdentityForRecord({ record: mappedRecord, recordIndex }),
          candidates: [],
        };
      },
    }]),
    { project: () => ({ status: "accepted", projections: [] }) },
  );
  const configuration = {
    providerId: "provider-1",
    configurationRevisionId: "revision-1",
    platform: "fixture",
    adapterKey: "fixture-retired-v1",
  };

  const live = await planner.plan({ configuration, page: validated.data });
  assert.equal(live.records.length, 1);
  await assert.rejects(
    planner.planArchive({ configuration, page: validated.data }),
    (error: unknown) => error instanceof ProviderImportPlanningError,
  );
});
