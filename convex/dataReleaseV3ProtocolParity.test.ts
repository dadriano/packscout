import {
  DATA_RELEASE_V3_SCHEMA_VERSION,
  PRODUCTION_DATA_RELEASE_V3_PATHS,
  productionDataReleaseV3PathSchema,
  productionPublicationPathSchema,
} from "@packscout/contracts";
import { describe, expect, test } from "vitest";
import * as services from "../packages/services/src/buyback-adjusted-ev-release-types.ts";
import * as convexLifecycle from "./dataReleaseV3Lifecycle";
import * as convexSearch from "./dataReleaseV3Search";

/**
 * The data_release_v3 wire protocol is duplicated deliberately: the Convex
 * lifecycle is the enforcement copy and the services release module is the
 * producer copy. This test pins every duplicated constant so the two
 * runtimes can never drift silently — a change on one side fails here until
 * the other side moves in lockstep.
 */
describe("data_release_v3 protocol parity", () => {
  test("schema and search algorithm versions match across runtimes", () => {
    expect(services.DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION).toBe(
      DATA_RELEASE_V3_SCHEMA_VERSION,
    );
    expect(services.DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION).toBe(
      convexSearch.DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
    );
  });

  test("hash domains and the empty chain hash are byte-identical", () => {
    expect(services.DATA_RELEASE_V3_BATCH_HASH_DOMAIN).toBe(
      convexLifecycle.DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
    );
    expect(services.DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN).toBe(
      convexLifecycle.DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
    );
    expect(services.DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN).toBe(
      convexLifecycle.DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
    );
    expect(services.DATA_RELEASE_V3_CONTENT_HASH_DOMAIN).toBe(
      convexLifecycle.DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
    );
    expect(services.DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN).toBe(
      convexLifecycle.DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN,
    );
    expect(services.DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN).toBe(
      convexLifecycle.DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
    );
    expect(services.EMPTY_DATA_RELEASE_V3_CHAIN_HASH).toBe(
      convexLifecycle.EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
    );
  });

  test("capacity bounds and deterministic batch packing match", () => {
    expect(services.MAX_DATA_RELEASE_V3_REPACKS).toBe(
      convexSearch.MAX_DATA_RELEASE_V3_REPACKS,
    );
    expect(services.MAX_DATA_RELEASE_V3_CATEGORIES).toBe(
      convexSearch.MAX_DATA_RELEASE_V3_CATEGORIES,
    );
    expect(services.MAX_DATA_RELEASE_V3_COLLECTIBLES).toBe(
      convexSearch.MAX_DATA_RELEASE_V3_COLLECTIBLES,
    );
    expect(services.MAX_DATA_RELEASE_V3_CHASES).toBe(
      convexSearch.MAX_DATA_RELEASE_V3_CHASES,
    );
    expect(services.MAX_ROWS_PER_DATA_RELEASE_V3_SHARD).toBe(
      convexSearch.MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
    );
    expect(services.MAX_DATA_RELEASE_V3_BATCH_RECORDS).toBe(
      convexLifecycle.MAX_DATA_RELEASE_V3_BATCH_RECORDS,
    );
    expect(services.MAX_DATA_RELEASE_V3_BATCH_RECORDS).toBe(
      100,
    );
    expect(convexLifecycle.MAX_DATA_RELEASE_V3_REPACK_BATCH_RECORDS).toBe(
      services.MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
    );
    expect([...services.DATA_RELEASE_V3_BATCH_KINDS]).toEqual([
      ...convexLifecycle.DATA_RELEASE_V3_BATCH_KINDS,
    ]);
  });

  test("every v3 publication path is accepted by the shared auth path schema", () => {
    for (const path of Object.values(PRODUCTION_DATA_RELEASE_V3_PATHS)) {
      expect(productionDataReleaseV3PathSchema.safeParse(path).success).toBe(
        true,
      );
      expect(productionPublicationPathSchema.safeParse(path).success).toBe(
        true,
      );
    }
    expect(Object.keys(PRODUCTION_DATA_RELEASE_V3_PATHS).sort()).toEqual([
      "activate",
      "activeState",
      "applyBatch",
      "finalize",
      "refreshProviderObservation",
      "retainedEvWitness",
      "rollback",
      "start",
      "status",
    ]);
  });
});
