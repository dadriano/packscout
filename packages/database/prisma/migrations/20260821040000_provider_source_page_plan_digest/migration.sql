-- The exact normalized page plus planned source-neutral effects remains
-- replay-verifiable after protected page evidence expires.
ALTER TABLE "import_pages"
  ADD COLUMN "normalized_commit_hash" TEXT,
  ADD CONSTRAINT "import_pages_normalized_commit_hash_check"
  CHECK (
    (
      "source_instance_id" IS NULL
      AND "normalized_commit_hash" IS NULL
    )
    OR (
      "source_instance_id" IS NOT NULL
      AND "normalized_commit_hash" IS NOT NULL
      AND "normalized_commit_hash" ~ '^[0-9a-f]{64}$'
    )
  );

COMMENT ON COLUMN "import_pages"."normalized_commit_hash" IS
  'SHA-256 of packscout.provider-source-page-commit.v1 canonical plan plus protected evidence; required for source-owned pages and null for legacy pages.';
