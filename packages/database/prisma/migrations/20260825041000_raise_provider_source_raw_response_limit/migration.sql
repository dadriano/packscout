-- Keep durable protected page evidence aligned with the sole contract-owned
-- launch response bound.
ALTER TABLE "import_pages"
  DROP CONSTRAINT "import_pages_normalized_runtime_shape_check",
  ADD CONSTRAINT "import_pages_normalized_runtime_shape_check"
  CHECK (
    "source_instance_id" IS NULL
    OR (
      "has_more" IS NULL
      AND "protected_raw_response_sha256" ~ '^[0-9a-f]{64}$'
      AND (
        (
          "protected_raw_response" IS NOT NULL
          AND octet_length("protected_raw_response") BETWEEN 1 AND 8388608
          AND "payload_expired_at" IS NULL
        )
        OR (
          "protected_raw_response" IS NULL
          AND "payload_expired_at" IS NOT NULL
        )
      )
    )
  );
