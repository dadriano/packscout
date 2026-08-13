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
