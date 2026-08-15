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
