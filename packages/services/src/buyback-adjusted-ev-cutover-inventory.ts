/**
 * Cutover inventory for the buyback-adjusted PackScout EV replacement
 * (task buyback-adjusted-ev/012).
 *
 * One machine-readable manifest of every pre-buyback calculator, projection,
 * public field, sort, KPI, fixture, glossary term, example, and telemetry
 * label affected by the semantic change, each with exactly one approved
 * disposition:
 *
 * - `replaced_by_v3` — the surface remains the active pre-cutover V2 runtime
 *   (or its presentation successor already carries the new method) and is
 *   replaced by the named V3 surface at the clean cutover. No alias, dual
 *   read, dual write, or mixed-version bridge is permitted in between.
 * - `historical_only` — immutable stored results or committed fixtures that
 *   keep their original pre-buyback identity forever and never enter a new
 *   release under buyback-adjusted labels.
 * - `retired` — a pre-buyback vocabulary element that is deliberately not
 *   carried into any new-method contract.
 *
 * The companion test (`buyback-adjusted-ev-cutover-inventory.test.ts`)
 * enforces the manifest two ways: every non-test source file that mentions a
 * pre-buyback token must be inventoried, and no V3/new-method surface may
 * mention any pre-buyback token at all.
 */

export const PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_VERSION =
  "packscout-buyback-ev-cutover-inventory-v1" as const;

export type PackScoutBuybackEvCutoverDispositionV1 =
  | "replaced_by_v3"
  | "historical_only"
  | "retired";

export type PackScoutBuybackEvCutoverItemKindV1 =
  | "calculator"
  | "projection"
  | "public_field"
  | "sort"
  | "kpi"
  | "fixture"
  | "glossary_term"
  | "example"
  | "telemetry_label";

export interface PackScoutBuybackEvCutoverInventoryItemV1 {
  /** Stable unique key for ledger references. */
  readonly itemKey: string;
  readonly kind: PackScoutBuybackEvCutoverItemKindV1;
  /** Repository-relative path of the affected surface. */
  readonly path: string;
  /** The exact pre-buyback element(s) the item governs. */
  readonly elements: readonly string[];
  readonly disposition: PackScoutBuybackEvCutoverDispositionV1;
  /**
   * Repository-relative path of the replacing V3 surface. Required exactly
   * when the disposition is `replaced_by_v3`.
   */
  readonly replacementPath: string | null;
  readonly note: string;
}

/**
 * Tokens that only the pre-buyback interpretation spells. Any non-test source
 * file containing one of these must appear in the inventory, and no
 * V3/new-method surface may contain any of them.
 */
export const PACKSCOUT_BUYBACK_EV_PRE_BUYBACK_TOKENS_V1 = Object.freeze([
  "estimated-ev",
  "estimated_ev",
  "estimatedEv",
  "EstimatedEv",
  "ESTIMATED_EV",
  "modelVersion",
  "ESTIMATE_INPUT_INCOMPLETE",
  "packscout_mock_ev",
] as const);

/**
 * Repository-relative prefixes of the V3/new-method surfaces that must never
 * consume or spell the pre-buyback interpretation. The pre-cutover V2 runtime
 * legitimately remains outside these prefixes until task 013 retires it.
 */
export const PACKSCOUT_BUYBACK_EV_V3_SURFACE_PREFIXES_V1 = Object.freeze([
  "packages/contracts/src/buyback-adjusted-ev-",
  "packages/contracts/src/data-release-v3",
  "packages/database/src/buyback-ev-",
  "packages/database/src/data-release-v3-",
  "packages/services/src/buyback-adjusted-ev-",
  "packages/services/src/data-release-v3-",
  "packages/services/src/providers/buyback-ev-evidence.ts",
  "convex/dataReleaseV3",
  "convex/publicRepacksV3",
] as const);

/**
 * Directories the pre-buyback token scan sweeps. `apps/frontend` is enforced
 * separately by item existence plus the V3 presentation tests it already
 * carries; the scan proved it free of pre-buyback tokens when this inventory
 * was approved.
 */
export const PACKSCOUT_BUYBACK_EV_INVENTORY_SCAN_ROOTS_V1 = Object.freeze([
  "packages",
  "apps/worker",
  "apps/admin",
  "convex",
  "scripts",
] as const);

function item(
  entry: PackScoutBuybackEvCutoverInventoryItemV1,
): PackScoutBuybackEvCutoverInventoryItemV1 {
  return Object.freeze(entry);
}

export const PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1: readonly PackScoutBuybackEvCutoverInventoryItemV1[] =
  Object.freeze([
    // -----------------------------------------------------------------
    // Calculators
    // -----------------------------------------------------------------
    item({
      itemKey: "calculator:estimated-ev",
      kind: "calculator",
      path: "packages/services/src/estimated-ev-calculator.ts",
      elements: [
        "calculatePackScoutEstimatedEv",
        "PACKSCOUT_ESTIMATED_EV_METHOD",
        "PACKSCOUT_ESTIMATED_EV_METHOD_VERSION",
      ],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-calculator.ts",
      note:
        "Pre-buyback bucket-weighted Gross EV; replaced by the buyback-adjusted task-002 calculator at cutover.",
    }),
    // -----------------------------------------------------------------
    // Projections and recomputation machinery
    // -----------------------------------------------------------------
    item({
      itemKey: "projection:estimated-ev-contracts",
      kind: "projection",
      path: "packages/services/src/estimated-ev-projection-contracts.ts",
      elements: ["CanonicalEstimatedEvProjectionContent"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-revision-contracts.ts",
      note:
        "Pre-buyback projection content and fingerprints; replaced by immutable buyback EV revisions.",
    }),
    item({
      itemKey: "projection:estimated-ev-repository",
      kind: "projection",
      path: "packages/services/src/estimated-ev-projection-repository.ts",
      elements: ["CanonicalEstimatedEvProjectionRepository"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-revision-store.ts",
      note: "Replaced by the task-005 immutable revision store.",
    }),
    item({
      itemKey: "projection:estimated-ev-service",
      kind: "projection",
      path: "packages/services/src/estimated-ev-service.ts",
      elements: ["PackScoutEstimatedEvService"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-service.ts",
      note: "Replaced by the task-006 recomputation boundary.",
    }),
    item({
      itemKey: "projection:estimated-ev-processor",
      kind: "projection",
      path: "packages/services/src/estimated-ev-recomputation-processor.ts",
      elements: ["EstimatedEvRecomputationProcessor"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-processor.ts",
      note: "Replaced by the buyback EV recomputation processor.",
    }),
    item({
      itemKey: "projection:estimated-ev-queue-repository",
      kind: "projection",
      path: "packages/database/src/estimated-ev-recomputation-repository.ts",
      elements: ["PrismaEstimatedEvRecomputationRepository"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/database/src/buyback-ev-revision-repository.ts",
      note:
        "Pre-buyback durable queue; the buyback EV path persists through the immutable revision repository.",
    }),
    item({
      itemKey: "projection:catalog-ev-input",
      kind: "projection",
      path: "packages/services/src/catalog-ev-input-projection.ts",
      elements: ["projectEvInputContent"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/providers/buyback-ev-evidence.ts",
      note:
        "Pre-buyback ev_input canonical projection; the new method normalizes provider evidence through the task-004 boundary.",
    }),
    item({
      itemKey: "projection:ingestion-enqueue",
      kind: "projection",
      path: "packages/database/src/ingestion-repository.ts",
      elements: ["estimated EV recomputation enqueue on ingestion"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-contracts.ts",
      note:
        "V2 ingestion enqueues estimated-EV work; V3 work items carry task-004 evidence outcomes.",
    }),
    item({
      itemKey: "projection:ingestion-page-batch-writer",
      kind: "projection",
      path: "packages/database/src/ingestion-page-batch-writer.ts",
      elements: ["estimated EV recomputation enqueue on page batches"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-contracts.ts",
      note: "Same enqueue integration as the ingestion repository.",
    }),
    item({
      itemKey: "projection:pipeline-types",
      kind: "projection",
      path: "packages/database/src/pipeline-types.ts",
      elements: ["estimated EV queue row types"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/database/src/buyback-ev-revision-repository.ts",
      note: "Queue row vocabulary for the pre-buyback pipeline.",
    }),
    item({
      itemKey: "projection:settlement-service",
      kind: "projection",
      path: "packages/services/src/public-change-settlement-service.ts",
      elements: ["estimated EV settlement obligations"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-assembler.ts",
      note:
        "V2 settlement derives estimated-EV obligations; V3 reads eligibility at one release clock.",
    }),
    item({
      itemKey: "projection:settlement-repository",
      kind: "projection",
      path: "packages/database/src/public-change-settlement-repository.ts",
      elements: ["estimated EV derivation rows"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/database/src/data-release-v3-canonical-catalog-adapter.ts",
      note: "Same settlement machinery on the persistence side.",
    }),
    item({
      itemKey: "projection:catalog-release-source",
      kind: "projection",
      path: "packages/database/src/catalog-release-source-repository.ts",
      elements: ["estimated EV inputs in the v2 release source read"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/database/src/data-release-v3-canonical-catalog-adapter.ts",
      note: "The V3 readAt-keyed canonical source replaces the v2 read.",
    }),
    item({
      itemKey: "projection:provider-catalog-release-source",
      kind: "projection",
      path: "packages/database/src/provider-catalog-release-source-repository.ts",
      elements: ["estimated EV inputs in the provider release source read"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/database/src/data-release-v3-canonical-catalog-adapter.ts",
      note: "Provider-scoped variant of the v2 release source read.",
    }),
    item({
      itemKey: "projection:catalog-release-projection",
      kind: "projection",
      path: "packages/services/src/catalog-release-public-projection.ts",
      elements: ["estimated EV public projection for data_release_v2"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-assembler.ts",
      note: "V2 public projection of pre-buyback estimates.",
    }),
    item({
      itemKey: "projection:catalog-release-types",
      kind: "projection",
      path: "packages/services/src/catalog-release-types.ts",
      elements: ["estimated EV fields in v2 release types"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-types.ts",
      note: "V2 release plan types carrying pre-buyback estimates.",
    }),
    item({
      itemKey: "projection:provider-catalog-release-projection",
      kind: "projection",
      path: "packages/services/src/provider-catalog-release-public-projection.ts",
      elements: ["estimated EV public projection for provider releases"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-assembler.ts",
      note: "Provider-scoped v2 projection of pre-buyback estimates.",
    }),
    item({
      itemKey: "projection:provider-catalog-release-types",
      kind: "projection",
      path: "packages/services/src/provider-catalog-release-types.ts",
      elements: ["estimated EV fields in provider release types"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-types.ts",
      note: "Provider-scoped v2 release types.",
    }),
    item({
      itemKey: "projection:distributed-provider-release-contract",
      kind: "projection",
      path: "packages/database/src/provider-release-contract.ts",
      elements: ["provider-local v2 PackScout EV public projection"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-assembler.ts",
      note:
        "The distributed immutable provider release retains the active v2 public contract until the buyback-adjusted release cutover.",
    }),
    item({
      itemKey: "projection:distributed-provider-release-money",
      kind: "projection",
      path: "packages/database/src/provider-release-money.ts",
      elements: [
        "v2 PackScout EV modelVersion",
        "v2 unavailable-reason vocabulary",
      ],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-assembler.ts",
      note:
        "The distributed release's v2 money projection is inventoried explicitly and cannot enter the V3 replacement surface.",
    }),
    item({
      itemKey: "projection:public-confidence",
      kind: "projection",
      path: "packages/services/src/public-confidence-projection.ts",
      elements: ["pre-buyback confidence projection"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-confidence.ts",
      note:
        "V2 confidence scoring; replaced by the task-003 confidence policy.",
    }),
    item({
      itemKey: "projection:provider-import-types",
      kind: "projection",
      path: "packages/services/src/provider-import-types.ts",
      elements: ["estimated EV import vocabulary"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/providers/buyback-ev-evidence.ts",
      note: "Import vocabulary feeding the pre-buyback path.",
    }),
    item({
      itemKey: "projection:beezie-mapper",
      kind: "projection",
      path: "packages/services/src/providers/beezie/mapper.ts",
      elements: ["estimated EV input mapping"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/providers/beezie/buyback-ev-evidence.ts",
      note: "Provider mapper feeding pre-buyback ev_input projections.",
    }),
    item({
      itemKey: "projection:clutchpacks-mapper",
      kind: "projection",
      path: "packages/services/src/providers/clutchpacks/mapper.ts",
      elements: ["estimated EV input mapping"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/providers/clutchpacks/buyback-ev-evidence.ts",
      note: "Provider mapper feeding pre-buyback ev_input projections.",
    }),
    item({
      itemKey: "projection:worker-estimated-ev",
      kind: "projection",
      path: "apps/worker/src/provider-worker-estimated-ev.ts",
      elements: ["createProviderWorkerEstimatedEvProcessor"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-processor.ts",
      note: "Worker wiring for the pre-buyback recomputation cycle.",
    }),
    item({
      itemKey: "projection:worker-runtime",
      kind: "projection",
      path: "apps/worker/src/provider-worker-runtime.ts",
      elements: ["ProviderWorkerEstimatedEvPort"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-processor.ts",
      note: "Worker runtime port for the pre-buyback cycle.",
    }),
    item({
      itemKey: "projection:worker-composition",
      kind: "projection",
      path: "apps/worker/src/provider-worker-composition.ts",
      elements: ["estimatedEv processor composition"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-service.ts",
      note: "Worker composition of the pre-buyback processor.",
    }),
    item({
      itemKey: "projection:worker-runtime-config",
      kind: "projection",
      path: "apps/worker/src/runtime-config.ts",
      elements: ["estimatedEvVerifiedUsdStablecoins"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/providers/buyback-ev-evidence.ts",
      note:
        "Stablecoin allowlist configuration for the pre-buyback calculator; the new method consumes parity approvals as evidence context.",
    }),
    item({
      itemKey: "projection:stored-estimated-ev-history",
      kind: "projection",
      path: "packages/database/prisma/schema.prisma",
      elements: ["persisted pre-buyback estimated EV projections and queue rows"],
      disposition: "historical_only",
      replacementPath: null,
      note:
        "Stored pre-buyback results keep their original method identity; they are never relabeled, selected, or mixed into the buyback-adjusted release.",
    }),
    item({
      itemKey: "projection:central-worker-activity-kind",
      kind: "projection",
      path: "packages/database/prisma/central/schema.prisma",
      elements: ["estimated_ev worker activity kind"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-processor.ts",
      note:
        "The split central control schema retains the pre-buyback worker activity label until the buyback-adjusted worker lane replaces it at cutover.",
    }),
    item({
      itemKey: "projection:central-worker-presence-activity",
      kind: "projection",
      path: "packages/database/src/central-worker-presence-repository.ts",
      elements: ["estimated_ev worker activity kind persistence"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-processor.ts",
      note:
        "The split central worker-presence repository persists the same pre-buyback activity label until the replacement lane is cut over.",
    }),
    item({
      itemKey: "projection:data-inspection-record-kinds",
      kind: "projection",
      path: "packages/contracts/src/data-inspection.ts",
      elements: ["estimated_ev inspectable record kind"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-contracts.ts",
      note:
        "Operator data inspection lists the pre-buyback record kind; the new method inspects buyback EV revisions.",
    }),
    item({
      itemKey: "projection:provider-canonical-inspection-estimated-ev",
      kind: "projection",
      path: "packages/database/src/provider-canonical-inspection-repository.ts",
      elements: ["estimated_ev provider canonical inspection projection"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/database/src/buyback-ev-revision-repository.ts",
      note:
        "Distributed admin inspection exposes the pre-buyback estimated-EV projection until the buyback EV revision repository becomes authoritative at cutover.",
    }),
    item({
      itemKey: "projection:provider-source-record-kinds",
      kind: "projection",
      path: "packages/contracts/src/provider-source-contract-v1.ts",
      elements: ["estimated_ev provider-source record kind"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-contracts.ts",
      note:
        "The provider-source contract still names the pre-buyback derived record kind.",
    }),
    item({
      itemKey: "projection:worker-presence-lanes",
      kind: "projection",
      path: "packages/contracts/src/worker-presence.ts",
      elements: ["estimated_ev worker lane"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-processor.ts",
      note:
        "Worker liveness reports a pre-buyback lane; the buyback EV processor supplies the replacement lane.",
    }),
    item({
      itemKey: "projection:worker-presence-repository",
      kind: "projection",
      path: "packages/database/src/worker-presence-repository.ts",
      elements: ["estimated_ev worker lane persistence"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-processor.ts",
      note: "Persistence side of the same pre-buyback worker lane.",
    }),
    item({
      itemKey: "projection:background-work-queue-read",
      kind: "projection",
      path: "packages/database/src/background-work-repository.ts",
      elements: [
        "estimated_ev_recomputation_requests",
        "estimated_ev_recomputation_state",
      ],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/database/src/buyback-ev-revision-repository.ts",
      note:
        "Admin background-work reads the pre-buyback durable queue; the buyback EV path persists through the immutable revision repository.",
    }),
    item({
      itemKey: "projection:provider-source-page-enqueue",
      kind: "projection",
      path: "packages/database/src/provider-source-page-repository.ts",
      elements: ["enqueueSourceEstimatedEvRecomputationInTransaction"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-contracts.ts",
      note:
        "Provider-source page commits enqueue pre-buyback recomputation; V3 work items carry task-004 evidence outcomes.",
    }),
    item({
      itemKey: "projection:provider-source-quarantine-enqueue",
      kind: "projection",
      path: "packages/database/src/provider-source-quarantine-repository.ts",
      elements: ["enqueueSourceEstimatedEvRecomputationInTransaction"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-contracts.ts",
      note: "Same enqueue integration on the quarantine recovery path.",
    }),
    item({
      itemKey: "projection:provider-catalog-release-validation",
      kind: "projection",
      path:
        "packages/services/src/provider-catalog-release-public-projection-validation.ts",
      elements: [
        "calculatePackScoutEstimatedEv",
        "estimatedEvCalculationFingerprint",
        "CanonicalEstimatedEvProjectionContent",
        "ESTIMATED_EV_UNAVAILABLE_REASONS",
      ],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-release-assembler.ts",
      note:
        "V2 release validation recomputes the pre-buyback estimate; V3 validates eligibility at one release clock.",
    }),
    // -----------------------------------------------------------------
    // Public fields
    // -----------------------------------------------------------------
    item({
      itemKey: "public-field:v2-packscout-ev",
      kind: "public_field",
      path: "packages/contracts/src/data-release-v2-values.ts",
      elements: [
        "packScoutEvSchema",
        "publicEvEstimatesSchema.packScout",
        "modelVersion",
      ],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note:
        "V2 public PackScout EV shape; V3 carries methodVersion, four buyback-adjusted metrics, and the bounded reason vocabulary.",
    }),
    item({
      itemKey: "public-field:v2-repack-entities",
      kind: "public_field",
      path: "packages/contracts/src/data-release-v2-entities.ts",
      elements: ["publicRepackDetailSchema.evEstimates"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-entities.ts",
      note: "V2 repack detail embedding the pre-buyback estimate.",
    }),
    item({
      itemKey: "public-field:v2-search-rows",
      kind: "public_field",
      path: "packages/contracts/src/data-release-v2-search.ts",
      elements: ["pre-buyback EV search-row columns"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-search.ts",
      note: "V2 search rows sort on pre-buyback estimates.",
    }),
    item({
      itemKey: "public-field:v2-convex-tables",
      kind: "public_field",
      path: "convex/schema.ts",
      elements: ["modelVersion columns on v2 release tables"],
      disposition: "replaced_by_v3",
      replacementPath: "convex/dataReleaseV3Lifecycle.ts",
      note:
        "V2 Convex release tables carry modelVersion; data_release_v3 tables carry methodVersion and the buyback-adjusted contract.",
    }),
    item({
      itemKey: "public-field:v2-reason-vocabulary",
      kind: "public_field",
      path: "packages/contracts/src/data-release-v2-values.ts",
      elements: [
        "ESTIMATE_INPUT_INCOMPLETE",
        "PRICE_UNAVAILABLE (v2 spelling)",
        "CURRENCY_UNSUPPORTED (v2 spelling)",
      ],
      disposition: "retired",
      replacementPath: null,
      note:
        "The pre-buyback unavailable-reason vocabulary is not carried forward; V3 defines its own bounded public reasons.",
    }),
    item({
      itemKey: "public-field:v2-model-version-label",
      kind: "public_field",
      path: "packages/contracts/src/data-release-v2-values.ts",
      elements: ["modelVersion public field name"],
      disposition: "retired",
      replacementPath: null,
      note:
        "V3 publishes methodVersion and confidencePolicyVersion; the modelVersion spelling ends with V2.",
    }),
    item({
      itemKey: "public-field:product-user-saved-estimate",
      kind: "public_field",
      path: "packages/contracts/src/product-users.ts",
      elements: [
        "ProductUserEstimatedEv",
        "savedItem.estimatedEv",
        "describeProductUserEstimatedEv",
      ],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note:
        "A saved item snapshots the published pre-buyback estimate; after the cutover the snapshot carries the buyback-adjusted metrics.",
    }),
    item({
      itemKey: "public-field:convex-saved-items",
      kind: "public_field",
      path: "convex/productUserSavedItems.ts",
      elements: ["estimatedEvValidator", "savedItem.estimatedEv"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note:
        "Convex read model for saved items stores the pre-buyback estimate shape.",
    }),
    item({
      itemKey: "public-field:admin-product-user-directory",
      kind: "public_field",
      path: "apps/admin/server/product-user-directory.ts",
      elements: ["readEstimatedEv", "ProductUserEstimatedEv"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note:
        "Admin directory reads the pre-buyback estimate off saved items.",
    }),
    item({
      itemKey: "public-field:admin-product-user-route",
      kind: "public_field",
      path: "apps/admin/server/routes/product-users.ts",
      elements: ["estimatedEv response projection"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note: "Admin API projects the pre-buyback estimate fields.",
    }),
    item({
      itemKey: "public-field:admin-product-user-detail-page",
      kind: "public_field",
      path: "apps/admin/src/pages/ProductUserDetailPage.tsx",
      elements: ["describeProductUserEstimatedEv", "item.estimatedEv"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note: "Admin detail page renders the pre-buyback estimate summary.",
    }),
    // -----------------------------------------------------------------
    // Sorts and KPIs
    // -----------------------------------------------------------------
    item({
      itemKey: "sort:public-repack-sorts",
      kind: "sort",
      path: "packages/contracts/src/public-repacks-query.ts",
      elements: [
        "packscout_gross_ev",
        "packscout_ev_dollars",
        "packscout_ev_percent",
        "packscout_confidence",
      ],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-search.ts",
      note:
        "The shared sort keys keep their spellings but bind to buyback-adjusted metrics in V3; no release may serve them from pre-buyback values.",
    }),
    item({
      itemKey: "kpi:ev-presentation",
      kind: "kpi",
      path: "apps/frontend/lib/packscout-ev-presentation.ts",
      elements: ["Gross EV / EV $ / EV % presentation"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note:
        "Task-010 presentation already consumes the buyback-adjusted V3 contract.",
    }),
    item({
      itemKey: "kpi:ev-metrics-component",
      kind: "kpi",
      path: "apps/frontend/components/metrics/PackScoutEvMetrics.tsx",
      elements: ["four-metric EV KPI block"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-ev-estimates.ts",
      note: "Renders the buyback-adjusted metrics together.",
    }),
    item({
      itemKey: "kpi:all-repacks-table",
      kind: "kpi",
      path: "apps/frontend/lib/all-repacks-table.ts",
      elements: ["EV table columns and default signed EV $ ranking"],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/data-release-v3-search.ts",
      note: "Table ranking binds to buyback-adjusted EV $ in V3.",
    }),
    // -----------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------
    item({
      itemKey: "fixture:contracts-v2",
      kind: "fixture",
      path: "packages/contracts/src/__fixtures__/data-release-v2.fixture.ts",
      elements: ["v2 packScout EV fixture values"],
      disposition: "historical_only",
      replacementPath: null,
      note:
        "Committed v2 contract fixture; retained as pre-buyback history under its original identity.",
    }),
    item({
      itemKey: "fixture:convex-mock-release",
      kind: "fixture",
      path: "convex/mockDataReleaseFixture.ts",
      elements: ["packscout_mock_ev_v1 modelVersion mock estimates"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-simulation-scenarios.ts",
      note:
        "The local mock release seeds pre-buyback-shaped estimates; the task-009 simulation replaces it as the local V3 source.",
    }),
    item({
      itemKey: "fixture:convex-mock-seed",
      kind: "fixture",
      path: "convex/mockDataReleaseSeed.ts",
      elements: ["seedMockCatalogManifestGraph entry point"],
      disposition: "replaced_by_v3",
      replacementPath: "scripts/local/simulate-convex-buyback-ev.mjs",
      note: "Mock seed mutation for the v2-era local catalog.",
    }),
    item({
      itemKey: "fixture:seed-script",
      kind: "fixture",
      path: "scripts/local/seed-convex-mock-data-release.mjs",
      elements: ["local mock release seeding"],
      disposition: "replaced_by_v3",
      replacementPath: "scripts/local/simulate-convex-buyback-ev.mjs",
      note: "Local seeding script for the v2-era mock release.",
    }),
    // -----------------------------------------------------------------
    // Glossary terms and examples
    // -----------------------------------------------------------------
    item({
      itemKey: "glossary:metric-vocabulary",
      kind: "glossary_term",
      path: "apps/frontend/lib/metric-vocabulary.ts",
      elements: ["Gross EV $", "Gross EV %", "EV $", "EV %", "Confidence"],
      disposition: "replaced_by_v3",
      replacementPath: "apps/frontend/lib/learn-content.ts",
      note:
        "Glossary definitions describe the probability-weighted final guaranteed buyback payout; tasks 010/011 own the approved wording.",
    }),
    item({
      itemKey: "glossary:hints",
      kind: "glossary_term",
      path: "apps/frontend/lib/glossary-hint.client.ts",
      elements: ["metric glossary hints"],
      disposition: "replaced_by_v3",
      replacementPath: "apps/frontend/lib/metric-vocabulary.ts",
      note: "Hint surfaces reuse the buyback-adjusted vocabulary.",
    }),
    item({
      itemKey: "example:learn-content",
      kind: "example",
      path: "apps/frontend/lib/learn-content.ts",
      elements: [
        "$100 outcome EV / 85% buyback / $100 price worked example",
      ],
      disposition: "replaced_by_v3",
      replacementPath: "packages/contracts/src/buyback-adjusted-ev-v1-common.ts",
      note:
        "The approved worked example produces $85 / 85% / -$15 / -15% under the buyback-adjusted method.",
    }),
    // -----------------------------------------------------------------
    // Telemetry labels
    // -----------------------------------------------------------------
    item({
      itemKey: "telemetry:worker-cycle-codes",
      kind: "telemetry_label",
      path: "apps/worker/src/provider-worker-runtime.ts",
      elements: ["ESTIMATED_EV_CYCLE_ERROR", "ESTIMATED_EV_REQUEST_FAILED"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-operational-monitor.ts",
      note:
        "Pre-buyback worker cycle failure codes; the buyback EV path reports BUYBACK_EV_* codes.",
    }),
    item({
      itemKey: "telemetry:runtime-config-code",
      kind: "telemetry_label",
      path: "apps/worker/src/runtime-config.ts",
      elements: ["ESTIMATED_EV_STABLECOINS_INVALID"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/providers/buyback-ev-evidence.ts",
      note: "Configuration failure code for the pre-buyback allowlist.",
    }),
    item({
      itemKey: "telemetry:estimated-ev-availability",
      kind: "telemetry_label",
      path: "packages/services/src/estimated-ev-service.ts",
      elements: ["calculation_availability_total for estimated EV"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-service.ts",
      note:
        "Availability telemetry now carries the buyback-adjusted outcome codes.",
    }),
    item({
      itemKey: "telemetry:admin-background-work-code",
      kind: "telemetry_label",
      path: "apps/admin/server/routes/background-work.ts",
      elements: ["ESTIMATED_EV_RECOMPUTATION_FAILED"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-operational-monitor.ts",
      note:
        "Admin background-work alert code for the pre-buyback queue; the buyback EV path reports BUYBACK_EV_* codes.",
    }),
    item({
      itemKey: "telemetry:admin-data-inspection-label",
      kind: "telemetry_label",
      path: "apps/admin/src/components/data-inspection/kind-presentation.ts",
      elements: ["estimated_ev operator label"],
      disposition: "replaced_by_v3",
      replacementPath:
        "packages/services/src/buyback-adjusted-ev-recomputation-contracts.ts",
      note:
        "Operator-facing label for the pre-buyback record kind in data inspection.",
    }),
  ]);

/** Every repository-relative path an inventory item references. */
export function packScoutBuybackEvCutoverInventoryPathsV1(): readonly string[] {
  return [
    ...new Set(
      PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.flatMap((entry) => [
        entry.path,
        ...(entry.replacementPath === null ? [] : [entry.replacementPath]),
      ]),
    ),
  ];
}

/** All items governing one repository-relative path. */
export function packScoutBuybackEvCutoverItemsForPathV1(
  repositoryRelativePath: string,
): readonly PackScoutBuybackEvCutoverInventoryItemV1[] {
  return PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.filter(
    (entry) => entry.path === repositoryRelativePath,
  );
}

/** Bounded disposition tallies for the readiness ledger. */
export function packScoutBuybackEvCutoverDispositionCountsV1(): Readonly<
  Record<PackScoutBuybackEvCutoverDispositionV1, number>
> {
  const counts = { replaced_by_v3: 0, historical_only: 0, retired: 0 };
  for (const entry of PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1) {
    counts[entry.disposition] += 1;
  }
  return counts;
}
