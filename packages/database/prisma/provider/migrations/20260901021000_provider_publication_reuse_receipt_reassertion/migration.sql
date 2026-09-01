-- The collectible-batch migration also tightens the terminal receipt proof.
-- Reassert the later ProviderCatalogRelease V1 reuse-aware predicate after
-- that migration so confirmReuse may advance only the selected checkpoint
-- while retaining the immutable release's original content boundary.
CREATE OR REPLACE FUNCTION "packscout_has_exact_provider_release_receipt"(
  p_receipt_id uuid,
  p_release_id uuid,
  p_through_change_sequence bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "provider_releases" AS release
    JOIN "provider_publication_operations" AS operation
      ON operation."provider_release_id" = release.id
    JOIN "provider_publication_receipts" AS receipt
      ON receipt."operation_id" = operation.id
     AND receipt."provider_release_id" = release.id
    CROSS JOIN LATERAL (
      SELECT convert_from(receipt."response_bytes", 'UTF8')::jsonb AS body
    ) AS exact_receipt
    WHERE release.id = p_release_id
      AND operation."operation_kind" IN ('finalize', 'confirmReuse')
      AND operation."batch_index" IS NULL
      AND operation."state" = 'accepted'
      AND receipt."outcome" = 'accepted'
      AND receipt."accepted_content_hash" = release."content_hash"
      AND receipt."accepted_record_count" = (
        SELECT COALESCE(sum(batch."record_count"), 0)::integer
        FROM "provider_release_batches" AS batch
        WHERE batch."provider_release_id" = release.id
      )
      AND exact_receipt.body->>'operationKind' = operation."operation_kind"
      AND exact_receipt.body->>'receiptDigest' = receipt."remote_receipt_id"
      AND exact_receipt.body->>'requestDigest' = operation."request_digest"
      AND exact_receipt.body->>'terminalState' = 'complete'
      AND exact_receipt.body#>>'{providerCheckpoint,settledSequence}' =
        p_through_change_sequence::text
      AND exact_receipt.body#>>'{details,completedHead,providerCheckpoint,settledSequence}' =
        p_through_change_sequence::text
      AND exact_receipt.body#>>'{details,completedHead,release,publicProviderReleaseId}' =
        exact_receipt.body->>'publicProviderReleaseId'
      AND (
        (
          operation."operation_kind" = 'finalize'
          AND release."through_change_sequence" = p_through_change_sequence
          AND exact_receipt.body->>'result' = 'completed'
        ) OR (
          operation."operation_kind" = 'confirmReuse'
          AND release."through_change_sequence" < p_through_change_sequence
          AND exact_receipt.body->>'result' = 'reused'
        )
      )
      AND (p_receipt_id IS NULL OR receipt.id = p_receipt_id)
  );
$$;
