BEGIN;

-- Active ProviderCatalogRelease V1 confirmReuse receipts advance a newer
-- provider-local selected boundary while retaining the immutable release's
-- original content boundary. Validate that distinction from the signed exact
-- receipt bytes instead of requiring every completion to be a fresh finalize.
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

-- A later lease fence may reconcile an immutable pending/ambiguous request
-- only when its current owner and fence are explicitly transaction-bound.
CREATE OR REPLACE FUNCTION "packscout_guard_publication_operation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  promotion_fence bigint;
  promotion_owner text;
  promotion_expiry timestamptz;
  reconciliation_owner text;
  reconciliation_fence bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_publication_operation_history_immutable';
  END IF;
  IF ROW(
    NEW.id, NEW."provider_release_id", NEW."operation_kind", NEW."batch_index",
    NEW."idempotency_key", NEW."request_digest", NEW."request_bytes", NEW."body_hash",
    NEW."lease_fence", NEW."requested_at"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."provider_release_id", OLD."operation_kind", OLD."batch_index",
    OLD."idempotency_key", OLD."request_digest", OLD."request_bytes", OLD."body_hash",
    OLD."lease_fence", OLD."requested_at"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_publication_operation_request_immutable';
  END IF;
  IF NEW."attempt_count" < OLD."attempt_count" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_publication_attempt_regression';
  END IF;
  IF OLD."state" IN ('accepted', 'failed')
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider_publication_operation_terminal_immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'pending' AND NEW."state" IN ('accepted', 'ambiguous', 'failed'))
    OR (OLD."state" = 'ambiguous' AND NEW."state" IN ('accepted', 'failed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'provider_publication_operation_transition_invalid';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NEW."state" IN ('accepted', 'failed') THEN
    SELECT "lease_fence", "lease_owner", "lease_expires_at"
      INTO promotion_fence, promotion_owner, promotion_expiry
    FROM "provider_worker_states" WHERE "worker_role" = 'promotion'
    FOR UPDATE;
    IF promotion_owner IS NULL
       OR promotion_expiry IS NULL
       OR promotion_expiry <= statement_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'stale_promotion_worker_fence';
    END IF;
    IF OLD."lease_fence" <> promotion_fence THEN
      reconciliation_owner := nullif(
        current_setting('packscout.provider_publication_reconciliation_owner', true),
        ''
      );
      BEGIN
        reconciliation_fence := nullif(
          current_setting('packscout.provider_publication_reconciliation_fence', true),
          ''
        )::bigint;
      EXCEPTION WHEN invalid_text_representation THEN
        reconciliation_fence := NULL;
      END;
      IF reconciliation_owner IS DISTINCT FROM promotion_owner
         OR reconciliation_fence IS DISTINCT FROM promotion_fence THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'stale_promotion_worker_fence';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "packscout_assert_publication_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_hash character(64);
  operation_state "publication_operation_state";
  operation_kind text;
  expected_count integer;
BEGIN
  SELECT
    CASE
      WHEN operation."operation_kind" IN ('finalize', 'confirmReuse')
        THEN release."content_hash"
      ELSE COALESCE(operation."body_hash", release."content_hash")
    END,
    operation."state",
    operation."operation_kind",
    CASE
      WHEN operation."operation_kind" IN ('finalize', 'confirmReuse') THEN (
        SELECT COALESCE(sum(batch."record_count"), 0)::integer
        FROM "provider_release_batches" AS batch
        WHERE batch."provider_release_id" = release.id
      )
      ELSE NEW."accepted_record_count"
    END
    INTO expected_hash, operation_state, operation_kind, expected_count
  FROM "provider_publication_operations" AS operation
  JOIN "provider_releases" AS release ON release.id = operation."provider_release_id"
  WHERE operation.id = NEW."operation_id"
    AND operation."provider_release_id" = NEW."provider_release_id";

  IF NEW."outcome" = 'accepted'
     AND (
       NEW."accepted_content_hash" IS DISTINCT FROM expected_hash
       OR operation_state <> 'accepted'
       OR NEW."accepted_record_count" IS DISTINCT FROM expected_count
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication_receipt_request_mismatch';
  END IF;
  IF NEW."outcome" = 'rejected' AND operation_state <> 'failed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'publication_rejection_operation_mismatch';
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
