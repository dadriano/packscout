/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as betaAllowlist from "../betaAllowlist.js";
import type * as betaAllowlistRecords from "../betaAllowlistRecords.js";
import type * as catalogManifestActivate from "../catalogManifestActivate.js";
import type * as catalogManifestBlock from "../catalogManifestBlock.js";
import type * as catalogManifestErrors from "../catalogManifestErrors.js";
import type * as catalogManifestOperations from "../catalogManifestOperations.js";
import type * as catalogManifestProviderProof from "../catalogManifestProviderProof.js";
import type * as catalogManifestRead from "../catalogManifestRead.js";
import type * as catalogManifestRefresh from "../catalogManifestRefresh.js";
import type * as catalogManifestRequests from "../catalogManifestRequests.js";
import type * as catalogManifestRetentionReferences from "../catalogManifestRetentionReferences.js";
import type * as catalogManifestRollback from "../catalogManifestRollback.js";
import type * as catalogManifestState from "../catalogManifestState.js";
import type * as catalogRetention from "../catalogRetention.js";
import type * as catalogRetentionErrors from "../catalogRetentionErrors.js";
import type * as catalogRetentionGraph from "../catalogRetentionGraph.js";
import type * as catalogRetentionOperations from "../catalogRetentionOperations.js";
import type * as catalogRetentionRead from "../catalogRetentionRead.js";
import type * as catalogRetentionRequests from "../catalogRetentionRequests.js";
import type * as catalogRetentionState from "../catalogRetentionState.js";
import type * as crons from "../crons.js";
import type * as dataReleaseCanonicalHash from "../dataReleaseCanonicalHash.js";
import type * as dataReleaseV3DisplayedEvMedian from "../dataReleaseV3DisplayedEvMedian.js";
import type * as dataReleaseV3DisplayedRepacks from "../dataReleaseV3DisplayedRepacks.js";
import type * as dataReleaseV3EvFacts from "../dataReleaseV3EvFacts.js";
import type * as dataReleaseV3EvFactsBackfill from "../dataReleaseV3EvFactsBackfill.js";
import type * as dataReleaseV3EvMigrationState from "../dataReleaseV3EvMigrationState.js";
import type * as dataReleaseV3Lifecycle from "../dataReleaseV3Lifecycle.js";
import type * as dataReleaseV3Pagination from "../dataReleaseV3Pagination.js";
import type * as dataReleaseV3ProviderObservation from "../dataReleaseV3ProviderObservation.js";
import type * as dataReleaseV3PublicPresentation from "../dataReleaseV3PublicPresentation.js";
import type * as dataReleaseV3Read from "../dataReleaseV3Read.js";
import type * as dataReleaseV3RetainedEv from "../dataReleaseV3RetainedEv.js";
import type * as dataReleaseV3Search from "../dataReleaseV3Search.js";
import type * as http from "../http.js";
import type * as mockCatalogManifestSeed from "../mockCatalogManifestSeed.js";
import type * as mockDataReleaseFixture from "../mockDataReleaseFixture.js";
import type * as mockDataReleaseSearch from "../mockDataReleaseSearch.js";
import type * as mockDataReleaseSeed from "../mockDataReleaseSeed.js";
import type * as mockHeatSimulationFixture from "../mockHeatSimulationFixture.js";
import type * as mockHeatSimulationPublisher from "../mockHeatSimulationPublisher.js";
import type * as mockProviderCatalogFixture from "../mockProviderCatalogFixture.js";
import type * as packCatalogErrors from "../packCatalogErrors.js";
import type * as packCatalogOperationStore from "../packCatalogOperationStore.js";
import type * as packCatalogPublicationAuth from "../packCatalogPublicationAuth.js";
import type * as packCatalogReadModel from "../packCatalogReadModel.js";
import type * as packCatalogSavedItems from "../packCatalogSavedItems.js";
import type * as packCatalogStoreSupport from "../packCatalogStoreSupport.js";
import type * as packCatalogV1 from "../packCatalogV1.js";
import type * as packCatalogValidators from "../packCatalogValidators.js";
import type * as packHeadRecovery from "../packHeadRecovery.js";
import type * as packSnapshotStore from "../packSnapshotStore.js";
import type * as productUserAccess from "../productUserAccess.js";
import type * as productUserAccessReview from "../productUserAccessReview.js";
import type * as productUserCapabilityGate from "../productUserCapabilityGate.js";
import type * as productUserDirectory from "../productUserDirectory.js";
import type * as productUserRecords from "../productUserRecords.js";
import type * as productUserSavedItems from "../productUserSavedItems.js";
import type * as productUserWelcome from "../productUserWelcome.js";
import type * as productUsers from "../productUsers.js";
import type * as productionDataReleaseAuth from "../productionDataReleaseAuth.js";
import type * as productionDataReleaseErrors from "../productionDataReleaseErrors.js";
import type * as productionHeatActiveState from "../productionHeatActiveState.js";
import type * as productionHeatBatch from "../productionHeatBatch.js";
import type * as productionHeatLifecycle from "../productionHeatLifecycle.js";
import type * as productionHeatOperations from "../productionHeatOperations.js";
import type * as productionHeatProtocol from "../productionHeatProtocol.js";
import type * as productionHeatRetention from "../productionHeatRetention.js";
import type * as productionPublicationKeyConfig from "../productionPublicationKeyConfig.js";
import type * as profileSnapshotStore from "../profileSnapshotStore.js";
import type * as providerCatalogDependentWrites from "../providerCatalogDependentWrites.js";
import type * as providerCatalogEntityWrites from "../providerCatalogEntityWrites.js";
import type * as providerCatalogInspection from "../providerCatalogInspection.js";
import type * as providerReleaseBatch from "../providerReleaseBatch.js";
import type * as providerReleaseBlock from "../providerReleaseBlock.js";
import type * as providerReleaseCleanup from "../providerReleaseCleanup.js";
import type * as providerReleaseDeletion from "../providerReleaseDeletion.js";
import type * as providerReleaseErrors from "../providerReleaseErrors.js";
import type * as providerReleaseFinalize from "../providerReleaseFinalize.js";
import type * as providerReleaseOperations from "../providerReleaseOperations.js";
import type * as providerReleaseProof from "../providerReleaseProof.js";
import type * as providerReleaseRead from "../providerReleaseRead.js";
import type * as providerReleaseRequests from "../providerReleaseRequests.js";
import type * as providerReleaseStart from "../providerReleaseStart.js";
import type * as providerReleaseState from "../providerReleaseState.js";
import type * as publicCatalogHeatReadModel from "../publicCatalogHeatReadModel.js";
import type * as publicCatalogManifestReadModel from "../publicCatalogManifestReadModel.js";
import type * as publicCatalogPagination from "../publicCatalogPagination.js";
import type * as publicCatalogReadAccess from "../publicCatalogReadAccess.js";
import type * as publicProviderCatalogReadModel from "../publicProviderCatalogReadModel.js";
import type * as publicRepackAggregates from "../publicRepackAggregates.js";
import type * as publicRepackValidation from "../publicRepackValidation.js";
import type * as publicRepacks from "../publicRepacks.js";
import type * as publicRepacksV3 from "../publicRepacksV3.js";
import type * as repackHeatReadModel from "../repackHeatReadModel.js";
import type * as repackHeatTestCatalog from "../repackHeatTestCatalog.js";
import type * as savedItems from "../savedItems.js";
import type * as tableColumnLayouts from "../tableColumnLayouts.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  betaAllowlist: typeof betaAllowlist;
  betaAllowlistRecords: typeof betaAllowlistRecords;
  catalogManifestActivate: typeof catalogManifestActivate;
  catalogManifestBlock: typeof catalogManifestBlock;
  catalogManifestErrors: typeof catalogManifestErrors;
  catalogManifestOperations: typeof catalogManifestOperations;
  catalogManifestProviderProof: typeof catalogManifestProviderProof;
  catalogManifestRead: typeof catalogManifestRead;
  catalogManifestRefresh: typeof catalogManifestRefresh;
  catalogManifestRequests: typeof catalogManifestRequests;
  catalogManifestRetentionReferences: typeof catalogManifestRetentionReferences;
  catalogManifestRollback: typeof catalogManifestRollback;
  catalogManifestState: typeof catalogManifestState;
  catalogRetention: typeof catalogRetention;
  catalogRetentionErrors: typeof catalogRetentionErrors;
  catalogRetentionGraph: typeof catalogRetentionGraph;
  catalogRetentionOperations: typeof catalogRetentionOperations;
  catalogRetentionRead: typeof catalogRetentionRead;
  catalogRetentionRequests: typeof catalogRetentionRequests;
  catalogRetentionState: typeof catalogRetentionState;
  crons: typeof crons;
  dataReleaseCanonicalHash: typeof dataReleaseCanonicalHash;
  dataReleaseV3DisplayedEvMedian: typeof dataReleaseV3DisplayedEvMedian;
  dataReleaseV3DisplayedRepacks: typeof dataReleaseV3DisplayedRepacks;
  dataReleaseV3EvFacts: typeof dataReleaseV3EvFacts;
  dataReleaseV3EvFactsBackfill: typeof dataReleaseV3EvFactsBackfill;
  dataReleaseV3EvMigrationState: typeof dataReleaseV3EvMigrationState;
  dataReleaseV3Lifecycle: typeof dataReleaseV3Lifecycle;
  dataReleaseV3Pagination: typeof dataReleaseV3Pagination;
  dataReleaseV3ProviderObservation: typeof dataReleaseV3ProviderObservation;
  dataReleaseV3PublicPresentation: typeof dataReleaseV3PublicPresentation;
  dataReleaseV3Read: typeof dataReleaseV3Read;
  dataReleaseV3RetainedEv: typeof dataReleaseV3RetainedEv;
  dataReleaseV3Search: typeof dataReleaseV3Search;
  http: typeof http;
  mockCatalogManifestSeed: typeof mockCatalogManifestSeed;
  mockDataReleaseFixture: typeof mockDataReleaseFixture;
  mockDataReleaseSearch: typeof mockDataReleaseSearch;
  mockDataReleaseSeed: typeof mockDataReleaseSeed;
  mockHeatSimulationFixture: typeof mockHeatSimulationFixture;
  mockHeatSimulationPublisher: typeof mockHeatSimulationPublisher;
  mockProviderCatalogFixture: typeof mockProviderCatalogFixture;
  packCatalogErrors: typeof packCatalogErrors;
  packCatalogOperationStore: typeof packCatalogOperationStore;
  packCatalogPublicationAuth: typeof packCatalogPublicationAuth;
  packCatalogReadModel: typeof packCatalogReadModel;
  packCatalogSavedItems: typeof packCatalogSavedItems;
  packCatalogStoreSupport: typeof packCatalogStoreSupport;
  packCatalogV1: typeof packCatalogV1;
  packCatalogValidators: typeof packCatalogValidators;
  packHeadRecovery: typeof packHeadRecovery;
  packSnapshotStore: typeof packSnapshotStore;
  productUserAccess: typeof productUserAccess;
  productUserAccessReview: typeof productUserAccessReview;
  productUserCapabilityGate: typeof productUserCapabilityGate;
  productUserDirectory: typeof productUserDirectory;
  productUserRecords: typeof productUserRecords;
  productUserSavedItems: typeof productUserSavedItems;
  productUserWelcome: typeof productUserWelcome;
  productUsers: typeof productUsers;
  productionDataReleaseAuth: typeof productionDataReleaseAuth;
  productionDataReleaseErrors: typeof productionDataReleaseErrors;
  productionHeatActiveState: typeof productionHeatActiveState;
  productionHeatBatch: typeof productionHeatBatch;
  productionHeatLifecycle: typeof productionHeatLifecycle;
  productionHeatOperations: typeof productionHeatOperations;
  productionHeatProtocol: typeof productionHeatProtocol;
  productionHeatRetention: typeof productionHeatRetention;
  productionPublicationKeyConfig: typeof productionPublicationKeyConfig;
  profileSnapshotStore: typeof profileSnapshotStore;
  providerCatalogDependentWrites: typeof providerCatalogDependentWrites;
  providerCatalogEntityWrites: typeof providerCatalogEntityWrites;
  providerCatalogInspection: typeof providerCatalogInspection;
  providerReleaseBatch: typeof providerReleaseBatch;
  providerReleaseBlock: typeof providerReleaseBlock;
  providerReleaseCleanup: typeof providerReleaseCleanup;
  providerReleaseDeletion: typeof providerReleaseDeletion;
  providerReleaseErrors: typeof providerReleaseErrors;
  providerReleaseFinalize: typeof providerReleaseFinalize;
  providerReleaseOperations: typeof providerReleaseOperations;
  providerReleaseProof: typeof providerReleaseProof;
  providerReleaseRead: typeof providerReleaseRead;
  providerReleaseRequests: typeof providerReleaseRequests;
  providerReleaseStart: typeof providerReleaseStart;
  providerReleaseState: typeof providerReleaseState;
  publicCatalogHeatReadModel: typeof publicCatalogHeatReadModel;
  publicCatalogManifestReadModel: typeof publicCatalogManifestReadModel;
  publicCatalogPagination: typeof publicCatalogPagination;
  publicCatalogReadAccess: typeof publicCatalogReadAccess;
  publicProviderCatalogReadModel: typeof publicProviderCatalogReadModel;
  publicRepackAggregates: typeof publicRepackAggregates;
  publicRepackValidation: typeof publicRepackValidation;
  publicRepacks: typeof publicRepacks;
  publicRepacksV3: typeof publicRepacksV3;
  repackHeatReadModel: typeof repackHeatReadModel;
  repackHeatTestCatalog: typeof repackHeatTestCatalog;
  savedItems: typeof savedItems;
  tableColumnLayouts: typeof tableColumnLayouts;
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
