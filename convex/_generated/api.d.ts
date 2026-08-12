/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as catalogCanonicalHash from "../catalogCanonicalHash.js";
import type * as mockCatalogFixture from "../mockCatalogFixture.js";
import type * as mockCatalogSeed from "../mockCatalogSeed.js";
import type * as publicCatalog from "../publicCatalog.js";
import type * as publicCatalogValidation from "../publicCatalogValidation.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  catalogCanonicalHash: typeof catalogCanonicalHash;
  mockCatalogFixture: typeof mockCatalogFixture;
  mockCatalogSeed: typeof mockCatalogSeed;
  publicCatalog: typeof publicCatalog;
  publicCatalogValidation: typeof publicCatalogValidation;
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
