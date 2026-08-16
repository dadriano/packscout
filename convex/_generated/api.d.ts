/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as dataReleaseCanonicalHash from "../dataReleaseCanonicalHash.js";
import type * as mockDataReleaseFixture from "../mockDataReleaseFixture.js";
import type * as mockDataReleaseSearch from "../mockDataReleaseSearch.js";
import type * as mockDataReleaseSeed from "../mockDataReleaseSeed.js";
import type * as mockHeatSimulationFixture from "../mockHeatSimulationFixture.js";
import type * as mockHeatSimulationPublisher from "../mockHeatSimulationPublisher.js";
import type * as productionDataReleaseAuth from "../productionDataReleaseAuth.js";
import type * as productionDataReleaseActiveState from "../productionDataReleaseActiveState.js";
import type * as productionDataReleaseBatch from "../productionDataReleaseBatch.js";
import type * as productionDataReleaseCatalogWrites from "../productionDataReleaseCatalogWrites.js";
import type * as productionDataReleaseDependentWrites from "../productionDataReleaseDependentWrites.js";
import type * as productionDataReleaseErrors from "../productionDataReleaseErrors.js";
import type * as productionDataReleaseLifecycle from "../productionDataReleaseLifecycle.js";
import type * as productionDataReleaseOperations from "../productionDataReleaseOperations.js";
import type * as productionDataReleaseProtocol from "../productionDataReleaseProtocol.js";
import type * as productionDataReleaseRollback from "../productionDataReleaseRollback.js";
import type * as productionDataReleaseRetention from "../productionDataReleaseRetention.js";
import type * as productionHeatActiveState from "../productionHeatActiveState.js";
import type * as productionHeatBatch from "../productionHeatBatch.js";
import type * as productionHeatLifecycle from "../productionHeatLifecycle.js";
import type * as productionHeatOperations from "../productionHeatOperations.js";
import type * as productionHeatProtocol from "../productionHeatProtocol.js";
import type * as productionHeatRetention from "../productionHeatRetention.js";
import type * as providerCatalogDependentWrites from "../providerCatalogDependentWrites.js";
import type * as providerCatalogEntityWrites from "../providerCatalogEntityWrites.js";
import type * as providerReleaseBatch from "../providerReleaseBatch.js";
import type * as providerReleaseBlock from "../providerReleaseBlock.js";
import type * as providerReleaseCleanup from "../providerReleaseCleanup.js";
import type * as providerReleaseErrors from "../providerReleaseErrors.js";
import type * as providerReleaseFinalize from "../providerReleaseFinalize.js";
import type * as providerReleaseOperations from "../providerReleaseOperations.js";
import type * as providerReleaseProof from "../providerReleaseProof.js";
import type * as providerReleaseRead from "../providerReleaseRead.js";
import type * as providerReleaseRequests from "../providerReleaseRequests.js";
import type * as providerReleaseStart from "../providerReleaseStart.js";
import type * as providerReleaseState from "../providerReleaseState.js";
import type * as publicRepackAggregates from "../publicRepackAggregates.js";
import type * as publicRepackReadModel from "../publicRepackReadModel.js";
import type * as publicRepackValidation from "../publicRepackValidation.js";
import type * as publicRepacks from "../publicRepacks.js";
import type * as repackHeatReadModel from "../repackHeatReadModel.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  dataReleaseCanonicalHash: typeof dataReleaseCanonicalHash;
  mockDataReleaseFixture: typeof mockDataReleaseFixture;
  mockDataReleaseSearch: typeof mockDataReleaseSearch;
  mockDataReleaseSeed: typeof mockDataReleaseSeed;
  mockHeatSimulationFixture: typeof mockHeatSimulationFixture;
  mockHeatSimulationPublisher: typeof mockHeatSimulationPublisher;
  productionDataReleaseAuth: typeof productionDataReleaseAuth;
  productionDataReleaseActiveState: typeof productionDataReleaseActiveState;
  productionDataReleaseBatch: typeof productionDataReleaseBatch;
  productionDataReleaseCatalogWrites: typeof productionDataReleaseCatalogWrites;
  productionDataReleaseDependentWrites: typeof productionDataReleaseDependentWrites;
  productionDataReleaseErrors: typeof productionDataReleaseErrors;
  productionDataReleaseLifecycle: typeof productionDataReleaseLifecycle;
  productionDataReleaseOperations: typeof productionDataReleaseOperations;
  productionDataReleaseProtocol: typeof productionDataReleaseProtocol;
  productionDataReleaseRollback: typeof productionDataReleaseRollback;
  productionDataReleaseRetention: typeof productionDataReleaseRetention;
  productionHeatActiveState: typeof productionHeatActiveState;
  productionHeatBatch: typeof productionHeatBatch;
  productionHeatLifecycle: typeof productionHeatLifecycle;
  productionHeatOperations: typeof productionHeatOperations;
  productionHeatProtocol: typeof productionHeatProtocol;
  productionHeatRetention: typeof productionHeatRetention;
  providerCatalogDependentWrites: typeof providerCatalogDependentWrites;
  providerCatalogEntityWrites: typeof providerCatalogEntityWrites;
  providerReleaseBatch: typeof providerReleaseBatch;
  providerReleaseBlock: typeof providerReleaseBlock;
  providerReleaseCleanup: typeof providerReleaseCleanup;
  providerReleaseErrors: typeof providerReleaseErrors;
  providerReleaseFinalize: typeof providerReleaseFinalize;
  providerReleaseOperations: typeof providerReleaseOperations;
  providerReleaseProof: typeof providerReleaseProof;
  providerReleaseRead: typeof providerReleaseRead;
  providerReleaseRequests: typeof providerReleaseRequests;
  providerReleaseStart: typeof providerReleaseStart;
  providerReleaseState: typeof providerReleaseState;
  publicRepackAggregates: typeof publicRepackAggregates;
  publicRepackReadModel: typeof publicRepackReadModel;
  publicRepackValidation: typeof publicRepackValidation;
  publicRepacks: typeof publicRepacks;
  repackHeatReadModel: typeof repackHeatReadModel;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
